import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  type ComputerChoice,
  type ComputerKind,
  isSetupTransitionAllowed,
  newId,
  type Workspace,
  type WorkspaceSummary,
} from '@milibot/shared'
import type { FastifyBaseLogger } from 'fastify'

import { extractBackupDb, inspectBackup, prepareImportedDb } from '../backup/archive'
import { type dataPaths, workspacePaths } from '../config/paths'
import { NewerSchemaError } from '../db/migrate'
import { DaemonError, errorMessage } from '../errors'
import type { GoldenBuilder } from '../golden/builder'
import type { WorkspaceEndpointName } from '../ipc/protocol'
import type { SecretStore } from '../secrets/secret-store'
import type { VmCli } from '../vm-cli'
import { copyWorkspaceSetup } from '../workspace-db/copy'
import { openWorkspaceDb } from '../workspace-db/open'
import { initWorkspaceDb } from '../workspace-db/seed'
import { holdVmStart, markSetupPending } from '../workspace-db/setup-keys'
import type { AppStore } from './app-store'
import type { EventHub } from './event-hub'
import type { AppHandlers } from './http'
import { vmDiskBytes } from './overview'
import type { RuntimeManager, RuntimeTarget } from './runtime-manager'

type NewWorkspace = Omit<Parameters<AppStore['insertWorkspace']>[0], 'id' | 'dir'>

/** A graceful stop gets the guest's 60 s shutdown plus margin. */
const VM_STOP_TIMEOUT_MS = { graceful: 75_000, force: 30_000 } as const

type WorkspaceHandlerName =
  | 'createWorkspace'
  | 'inspectBackup'
  | 'importWorkspace'
  | 'setupWorkspaceComputer'
  | 'updateWorkspaceSetup'
  | 'updateWorkspace'
  | 'setWorkspaceComputer'
  | 'deleteWorkspaceVm'
  | 'deleteWorkspace'
  | 'openWorkspace'
  | 'closeWorkspace'

export interface WorkspaceHandlerDeps {
  paths: ReturnType<typeof dataPaths>
  store: AppStore
  runtimes: RuntimeManager
  hub: EventHub
  golden: GoldenBuilder
  secretStore: SecretStore
  vmCli: () => VmCli
  log: FastifyBaseLogger
  summarize: (workspace: Workspace) => WorkspaceSummary
  publishWorkspace: (workspace: Workspace) => WorkspaceSummary
  target: (workspace: Workspace) => RuntimeTarget
  requestRuntime: (workspace: Workspace, name: WorkspaceEndpointName, body?: unknown) => Promise<unknown>
  /** A set-up workspace switched to a VM gets it once the golden build in progress is ready. */
  waitForGolden: (workspaceId: string) => void
}

/** Workspace lifecycle routes of the supervisor: create/import, setup, update, delete, open and close. */
export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps): Pick<AppHandlers, WorkspaceHandlerName> {
  const { store, runtimes, hub, golden, secretStore, log, summarize, publishWorkspace, requestRuntime } = deps

  /** Creates the folder of a new workspace, fills it, then registers it; a failure leaves nothing behind. */
  const withNewWorkspaceDir = async (
    fill: (id: string, wsPaths: ReturnType<typeof workspacePaths>) => Promise<NewWorkspace>,
  ): Promise<WorkspaceSummary> => {
    const id = newId('workspace')
    const dir = join(deps.paths.workspacesDir, id)
    mkdirSync(dir, { recursive: true })
    try {
      const input = await fill(id, workspacePaths(dir))
      const workspace = summarize(store.insertWorkspace({ ...input, id, dir }))
      hub.publishApp({ type: 'workspace.created', payload: { workspace } })
      return workspace
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      await secretStore.deleteNamespace(id).catch(() => undefined)
      throw err
    }
  }

  /** A VM left running without a runtime (keep_running + daemon restart) is stopped through the VM CLI. */
  const stopLeftoverVm = async (workspace: Workspace, mode: 'graceful' | 'force') => {
    if (!existsSync(workspacePaths(workspace.dir).qemuPid)) {
      return
    }

    const flags = mode === 'force' ? ['--force'] : ['--timeout-sec', '60']
    await deps
      .vmCli()
      .run(['stop', workspace.dir, ...flags], { timeoutMs: VM_STOP_TIMEOUT_MS[mode] })
      .catch((err: unknown) => log.warn({ err, workspaceId: workspace.id }, 'failed to stop workspace VM'))
  }

  /** Only while no runtime holds the workspace's database. */
  const holdVmStartOf = (workspace: Workspace) => {
    const db = openWorkspaceDb(workspacePaths(workspace.dir).db)
    try {
      holdVmStart(db)
    } finally {
      db.close()
    }
  }

  /**
   * The computer is fixed for a runtime's lifetime, so a new one restarts it; leaving the VM stops it and
   * keeps its disks.
   */
  const restartOnComputer = async (workspace: Workspace, computer: ComputerKind) => {
    const leavesVm = workspace.computer === 'vm'
    const prepare = async () => {
      if (leavesVm) {
        await stopLeftoverVm(workspace, 'graceful')
      }

      // Else the new runtime boots the VM on start, before it gets the size or learns the image isn't ready.
      if (computer === 'vm') {
        holdVmStartOf(workspace)
      }

      store.setComputer(workspace.id, computer)
    }

    await runtimes.restart(workspace.id, store.getSettings().language, {
      vm: leavesVm ? 'stop' : 'keep',
      prepare,
      next: () => deps.target(store.getWorkspace(workspace.id)),
    })
  }

  /** Stores the workspace's computer and has its runtime apply it. */
  const applyComputer = async (workspace: Workspace, choice: ComputerChoice): Promise<Workspace> => {
    if (workspace.computer !== choice.kind) {
      await restartOnComputer(workspace, choice.kind)
    }

    const updated = store.getWorkspace(workspace.id)

    // An outdated image is rebuilt first, so a new VM starts on the current system.
    const goldenStatus = golden.status()
    const goldenReady = goldenStatus.state === 'ready' && !goldenStatus.outdated
    await requestRuntime(updated, 'configureComputer', { choice, start: goldenReady })
    if (choice.kind === 'vm' && !goldenReady) {
      if (updated.setup === 'done') {
        deps.waitForGolden(updated.id)
      }
      golden.build()
    }

    return updated
  }

  return {
    createWorkspace: ({ body }) => {
      const source = body.copyFrom ? store.getWorkspace(body.copyFrom.workspaceId) : null
      return withNewWorkspaceDir(async (id, wsPaths) => {
        initWorkspaceDb(wsPaths.db, store.getSettings().language)
        if (body.setup || (source && body.copyFrom)) {
          const db = openWorkspaceDb(wsPaths.db)
          try {
            if (body.setup) markSetupPending(db)
            if (source && body.copyFrom) {
              await copyWorkspaceSetup({
                sourceDb: workspacePaths(source.dir).db,
                sourceWorkspaceId: source.id,
                target: db,
                targetWorkspaceId: id,
                secrets: secretStore,
                options: body.copyFrom,
              })
            }
          } finally {
            db.close()
          }
        }
        return {
          name: body.name,
          color: body.color,
          icon: body.icon ?? null,
          closeBehavior: body.closeBehavior,
          computer: body.computer,
          setup: body.setup ? 'providers' : 'done',
        }
      })
    },

    inspectBackup: ({ body }) => inspectBackup(body.path),

    importWorkspace: ({ body }) =>
      withNewWorkspaceDir(async (_id, wsPaths) => {
        const extracted = await extractBackupDb(body.path, wsPaths.db)
        let db
        try {
          db = openWorkspaceDb(wsPaths.db)
        } catch (err) {
          const reason = err instanceof NewerSchemaError ? 'newer_version' : 'not_a_backup'
          throw new DaemonError('validation_failed', errorMessage(err), { reason })
        }
        try {
          prepareImportedDb(db, {
            backupPath: body.path,
            hasWorkspace: extracted.hasWorkspace,
            workspaceBytes: extracted.bytes,
            now: Date.now(),
          })
        } finally {
          db.close()
        }
        return { name: body.name, color: body.color, icon: null, setup: 'providers' }
      }),

    setupWorkspaceComputer: async ({ params, body }) => {
      const workspace = store.getWorkspace(params.workspaceId)
      if (workspace.setup !== 'providers' && workspace.setup !== 'vm') {
        throw new DaemonError('conflict', 'The workspace computer was already set up')
      }

      await applyComputer(workspace, body)
      return publishWorkspace(store.setSetupStep(workspace.id, 'vm'))
    },

    updateWorkspaceSetup: async ({ params, body: { step } }) => {
      const workspace = store.getWorkspace(params.workspaceId)
      if (!isSetupTransitionAllowed(workspace.setup, step)) {
        throw new DaemonError('conflict', `Setup cannot go from ${workspace.setup} to ${step}`)
      }
      if (step === 'done' && workspace.setup !== 'done') await requestRuntime(workspace, 'finishSetup')
      return publishWorkspace(store.setSetupStep(workspace.id, step))
    },

    updateWorkspace: ({ params, body }) => {
      const workspace = store.updateWorkspace(params.workspaceId, body)
      if (body.closeBehavior) runtimes.closeBehaviorChanged(workspace.id, workspace.closeBehavior)
      return publishWorkspace(workspace)
    },

    setWorkspaceComputer: async ({ params, body }) => {
      const workspace = store.getWorkspace(params.workspaceId)
      if (workspace.setup !== 'done') {
        throw new DaemonError('conflict', 'The workspace is still being set up')
      }

      return publishWorkspace(await applyComputer(workspace, body))
    },

    deleteWorkspaceVm: async ({ params: { workspaceId: id } }) => {
      const workspace = store.getWorkspace(id)
      if (workspace.computer === 'vm') {
        throw new DaemonError('conflict', 'The workspace still uses its VM')
      }

      await stopLeftoverVm(workspace, 'force')
      const freedBytes = vmDiskBytes(workspace) ?? 0
      rmSync(workspacePaths(workspace.dir).vmDir, { recursive: true, force: true })
      return { freedBytes }
    },

    deleteWorkspace: async ({ params: { workspaceId: id } }) => {
      const workspace = store.getWorkspace(id)
      await runtimes.stop(id, { vm: 'force' })
      await stopLeftoverVm(workspace, 'force')
      store.deleteWorkspace(id)
      hub.closeWorkspace(id)
      rmSync(workspace.dir, { recursive: true, force: true })
      await secretStore.deleteNamespace(id).catch((err: unknown) => {
        log.warn({ err, workspaceId: id }, 'failed to delete workspace secrets')
      })
      hub.publishApp({ type: 'workspace.deleted', payload: { workspaceId: id } })
      return { ok: true }
    },

    openWorkspace: async ({ params: { workspaceId: id } }) => {
      const workspace = store.getWorkspace(id)
      await runtimes.ensure(deps.target(workspace), store.getSettings().language)
      runtimes.opened(id)
      return publishWorkspace(store.touchOpened(id))
    },

    closeWorkspace: async ({ params: { workspaceId: id } }) => {
      const workspace = store.getWorkspace(id)
      if (workspace.closeBehavior === 'suspend_vm' && runtimes.isRunning(id)) {
        await requestRuntime(workspace, 'stopVm')
      }
      return summarize(workspace)
    },
  }
}
