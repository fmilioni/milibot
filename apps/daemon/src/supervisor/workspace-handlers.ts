import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { isSetupTransitionAllowed, newId, type Workspace, type WorkspaceSummary } from '@milibot/shared'
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
import { markSetupPending } from '../workspace-db/setup-keys'
import type { AppStore } from './app-store'
import type { EventHub } from './event-hub'
import type { AppHandlers } from './http'
import type { RuntimeManager, RuntimeTarget } from './runtime-manager'

type NewWorkspace = Omit<Parameters<AppStore['insertWorkspace']>[0], 'id' | 'dir'>

type WorkspaceHandlerName =
  | 'createWorkspace'
  | 'inspectBackup'
  | 'importWorkspace'
  | 'setupWorkspaceVm'
  | 'updateWorkspaceSetup'
  | 'updateWorkspace'
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

    setupWorkspaceVm: async ({ params, body }) => {
      const workspace = store.getWorkspace(params.workspaceId)
      if (workspace.setup !== 'providers' && workspace.setup !== 'vm') {
        throw new DaemonError('conflict', 'The workspace VM was already set up')
      }
      // An outdated image is rebuilt first, so a new workspace starts on the current system.
      const goldenStatus = golden.status()
      const goldenReady = goldenStatus.state === 'ready' && !goldenStatus.outdated
      await requestRuntime(workspace, 'configureSetupVm', { ...body, start: goldenReady })
      if (!goldenReady) golden.build()
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

    deleteWorkspace: async ({ params: { workspaceId: id } }) => {
      const workspace = store.getWorkspace(id)
      await runtimes.stop(id, { vm: 'force' })
      if (existsSync(workspacePaths(workspace.dir).qemuPid)) {
        // A VM left running without a runtime (keep_running + daemon restart) must not outlive its disks.
        await deps
          .vmCli()
          .run(['stop', workspace.dir, '--force'], { timeoutMs: 30_000 })
          .catch((err: unknown) => log.warn({ err, workspaceId: id }, 'failed to stop workspace VM'))
      }
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
