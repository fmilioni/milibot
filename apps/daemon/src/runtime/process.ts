import { join } from 'node:path'

import { type AgentHost, createAgentHost } from '@milibot/agent'
import { fakeGenerateImages } from '@milibot/agent/images'
import { type CloseBehavior, DEFAULT_VM_CONFIG, type LogFn, type WorkspaceEvent } from '@milibot/shared'

import type { RuntimeConfig } from '../config/env'
import { DAEMON_VERSION, workspacePaths } from '../config/paths'
import type { Db } from '../db/sqlite'
import { errorMessage } from '../errors'
import { resolveGoldenImage } from '../golden/resolve'
import { expectedGoldenRevision } from '../golden/revision'
import type { SupervisorCallClient } from '../ipc/calls'
import type { VmShutdownMode } from '../ipc/protocol'
import { createSecretStore } from '../secrets/factory'
import type { SecretStore } from '../secrets/secret-store'
import { createShellVmCli, defaultVmScript, loadGuestAgentBundle, type VmCli, vmRootDir } from '../vm-cli'
import { openWorkspaceDb } from '../workspace-db/open'
import { seedWorkspace } from '../workspace-db/seed'
import { SETUP_VM_PENDING_KEY, SETUP_VM_WAIT_GOLDEN_KEY } from '../workspace-db/setup-keys'
import type { RuntimeOverrides } from './composition/container'
import { lazy } from './composition/lazy'
import { defaultDesignAssets } from './design'
import { fakeEmbeddingFactory } from './embeddings/fake'
import { SharedLocalEmbeddingProvider } from './embeddings/supervisor-provider'
import { createWorkspaceRuntime, type WorkspaceRuntime } from './runtime'
import { botSliceLimits, readPreferences } from './settings'
import { readVmConfig } from './vm'
import { createPlaceholderVm, QemuVmController, type QemuVmOptions, type VmController } from './vm/controller'

/** What a runtime process plugs in, and the seams tests replace. */
export interface RuntimeProcessOverrides {
  emit?: (event: WorkspaceEvent) => void
  log?: LogFn
  /** The supervisor's shared local embedding models (absent: local models run in this process). */
  calls?: SupervisorCallClient
  agentHost?: AgentHost
  secrets?: SecretStore
  /** The VM CLI (default: the script of `MILIBOT_VM_CLI`, else the repository's). */
  vmCli?: VmCli
  /** More QEMU controller options (tests: a fake guest, fast polling). */
  vm?: Partial<QemuVmOptions>
  runtime?: RuntimeOverrides
}

export interface RuntimeProcess {
  readonly runtime: WorkspaceRuntime
  readonly db: Db
  readonly vm: VmController
  /** Seeds the workspace (first bot, defaults, the user's language) and starts the runtime. */
  start(): Promise<void>
  /** A window opened the workspace: a runtime started in the background boots its VM now. */
  opened(): void
  closeBehaviorChanged(closeBehavior: CloseBehavior): void
  stop(vm: VmShutdownMode): Promise<void>
}

/** The workspace runtime a forked process runs, built from its environment (`readRuntimeConfig`). */
export function createRuntimeFromConfig(
  config: RuntimeConfig,
  overrides: RuntimeProcessOverrides = {},
): RuntimeProcess {
  const emit = overrides.emit ?? (() => {})
  const log = overrides.log ?? (() => {})
  const db = openWorkspaceDb(workspacePaths(config.workspaceDir).db)
  const runtimeRef = lazy<WorkspaceRuntime>('runtime')
  const store = () => runtimeRef.get().store
  const preferences = () => readPreferences((key, fallback) => store().settings.get(key, fallback))
  const vmEnabled = !config.vmDisabled
  let closeBehavior = config.closeBehavior
  let background = config.background

  let vm: VmController = createPlaceholderVm()
  if (vmEnabled) {
    try {
      const vmScript = defaultVmScript(config.vmScripts.cli)
      vm = new QemuVmController({
        workspaceDir: config.workspaceDir,
        workspaceName: config.workspaceName,
        portBase: config.vmPortBase,
        cli: overrides.vmCli ?? createShellVmCli(vmScript),
        agentBundle: () => loadGuestAgentBundle(vmScript),
        latestGoldenRevision: () => expectedGoldenRevision(vmRootDir(vmScript)),
        botLimits: () => botSliceLimits(preferences()),
        golden: () => resolveGoldenImage(config.dataRoot, config.platformDataRoot, config.goldenImage),
        settings: () =>
          readVmConfig((key, fallback) => store().settings.get(key, fallback), DEFAULT_VM_CONFIG),
        bots: () => store().bots.list(),
        pendingRemovals: () => store().bots.pendingRemovals(),
        onBotRemoved: (slug) => store().bots.markRemovedFromVm(slug),
        emit: (info) => {
          emit({ type: 'vm.status', payload: { vm: info } })
          runtimeRef.get().services.workspaceStatus.changed()
        },
        log,
        ...overrides.vm,
      })
    } catch (err) {
      log('error', 'VM controller unavailable', { err: errorMessage(err) })
    }
  }

  const vmAutostart = () =>
    vmEnabled &&
    config.vmAutostart &&
    preferences().vmAutostart &&
    !store().settings.get<boolean>(SETUP_VM_PENDING_KEY, false) &&
    !store().settings.get<boolean>(SETUP_VM_WAIT_GOLDEN_KEY, false)
  const modelsDir = join(config.dataRoot, 'models')
  const calls = overrides.calls
  const runtime = runtimeRef.set(
    createWorkspaceRuntime({
      workspaceId: config.workspaceId,
      workspaceDir: config.workspaceDir,
      workspaceName: config.workspaceName,
      db,
      emit,
      vm,
      agentHost: overrides.agentHost ?? createAgentHost(),
      secrets:
        overrides.secrets ?? createSecretStore({ kind: config.secretStore, dataRoot: config.dataRoot }),
      fakeScriptPath: config.fakeLlm,
      // Without a window, a workspace set to suspend its VM on close keeps it off until one opens.
      vmAutostart: () => vmAutostart() && !(background && closeBehavior === 'suspend_vm'),
      enableCliEngines: true,
      closeBehavior: vmEnabled ? () => closeBehavior : undefined,
      version: DAEMON_VERSION,
      log,
      overrides: {
        embeddings: {
          modelsDir,
          local: calls
            ? (level, onProgress) => new SharedLocalEmbeddingProvider(level, { calls, modelsDir, onProgress })
            : undefined,
          create: config.fakeEmbeddings ? fakeEmbeddingFactory() : undefined,
        },
        builtinSkillsDir: config.builtinSkillsDir ?? undefined,
        design: {
          fontsDir: join(config.dataRoot, 'fonts'),
          assets: config.designAssetsDir ? defaultDesignAssets(config.designAssetsDir) : undefined,
        },
        imageGenerate: config.fakeImages ? fakeGenerateImages : undefined,
        ...overrides.runtime,
      },
    }),
  )

  return {
    runtime,
    db,
    vm,
    async start() {
      seedWorkspace(runtime.store, config.language)
      await runtime.start()
    },
    opened() {
      if (!background) return
      background = false
      const state = vm.status().state
      if (vmAutostart() && state !== 'running' && state !== 'starting') {
        vm.start().catch((err: unknown) => log('warn', 'VM start failed', { err: errorMessage(err) }))
      }
    },
    closeBehaviorChanged(next) {
      closeBehavior = next
    },
    async stop(vmMode) {
      await runtime.stop(vmMode).catch(() => undefined)
      db.close()
    },
  }
}
