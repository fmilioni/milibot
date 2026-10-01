import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { whpxUsable, type Workspace, type WorkspaceSummary } from '@milibot/shared'
import type { FastifyInstance } from 'fastify'

import { type DaemonConfig, readDaemonConfig } from '../config/env'
import { DAEMON_VERSION, dataPaths, workspacePaths } from '../config/paths'
import { DaemonError } from '../errors'
import { GoldenBuilder } from '../golden/builder'
import { resolveGoldenImage } from '../golden/resolve'
import { hostInfo } from '../host/info'
import { hostSetup, systemHostProbe } from '../host/setup'
import { WindowsHypervisorProbe } from '../host/windows-hypervisor'
import { RuntimeCallServer } from '../ipc/calls'
import type { WorkspaceEndpointName } from '../ipc/protocol'
import { logFn } from '../logging'
import { hostSecretStore, type SecretStoreInfo } from '../secrets/factory'
import type { SecretStore } from '../secrets/secret-store'
import { createShellVmCli, defaultVmScript } from '../vm-cli'
import { countEnabledRoutines } from '../workspace-db/readonly-queries'
import { AppStore } from './app-store'
import { selectAutoStart } from './autostart'
import { SharedEmbeddingModels } from './embedding-models'
import { EventHub } from './event-hub'
import { type AppHandlers, createHttpApp, generateToken, registerRoutes } from './http'
import { workspaceOverview } from './overview'
import { type RuntimeLauncher, RuntimeManager } from './runtime-manager'
import { createWorkspaceHandlers } from './workspace-handlers'

export interface SupervisorOptions {
  dataRoot: string
  token?: string
  secretStore: SecretStore
  /** Which store `secretStore` is (reported by `GET /host`). */
  secretStoreInfo?: SecretStoreInfo
  /** `POST /shutdown` (after the response is sent); without it the route only answers. */
  requestShutdown?: (reason: string) => void
  runtime: RuntimeLauncher
  /** Settings from the environment (default: this process's, `readDaemonConfig`); `dataRoot` wins over it. */
  config?: Partial<DaemonConfig>
  /** Shared local embedding models (tests: a fake worker, a short idle timeout). */
  embeddings?: { workerUrl?: URL; idleUnloadMs?: number; remoteHost?: string }
  /** Windows Hypervisor Platform check of `GET /host` (default: the real one on Windows, none elsewhere). */
  windowsHypervisor?: WindowsHypervisorProbe | null
}

export interface Supervisor {
  readonly app: FastifyInstance
  readonly token: string
  readonly store: AppStore
  readonly runtimes: RuntimeManager
  /** The local embedding model processes shared by all workspaces. */
  readonly embeddingModels: SharedEmbeddingModels
  listen(port: number): Promise<number>
  /** Starts the runtimes of the previous session that work in the background (see `selectAutoStart`). */
  autoStartRuntimes(): Promise<string[]>
  close(): Promise<void>
}

const MAX_PORT_MOVES = 3

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const config: DaemonConfig = { ...readDaemonConfig(), ...options.config, dataRoot: options.dataRoot }
  const paths = dataPaths(options.dataRoot)
  mkdirSync(paths.workspacesDir, { recursive: true })
  mkdirSync(paths.logsDir, { recursive: true })

  const token = options.token ?? generateToken()
  const store = AppStore.open(paths.appDb, { vmPortFirst: config.vmPortFirst })
  const hub = new EventHub()
  const app = createHttpApp({ token, logLevel: config.logLevel, logRequests: config.logRequests })
  const startedAt = Date.now()

  const summarize = (workspace: Workspace): WorkspaceSummary => ({
    ...workspace,
    runtimeStatus: runtimes.status(workspace.id),
  })

  const embeddingModels = new SharedEmbeddingModels({
    cacheDir: join(options.dataRoot, 'models'),
    ...options.embeddings,
    log: logFn(app.log),
  })
  const runtimeCalls = new RuntimeCallServer(embeddingModels.handlers())

  const runtimes: RuntimeManager = new RuntimeManager({
    launcher: options.runtime,
    calls: runtimeCalls,
    onEvent: (workspaceId, event) => {
      hub.publishWorkspace(workspaceId, event)
      if (event.type === 'vm.status') watchPortConflict(workspaceId, event.payload.vm.errorCode)
    },
    onStatus: (workspaceId, status) => {
      if (status === 'running') store.setLastRunning(workspaceId, true)
      hub.publishWorkspace(workspaceId, { type: 'runtime.status', payload: { status } })
      const workspace = store.findWorkspace(workspaceId)
      if (workspace) publishWorkspace(workspace)
    },
    log: logFn(app.log),
  })

  const goldenImage = () => resolveGoldenImage(options.dataRoot, config.platformDataRoot, config.goldenImage)
  const vmCli = () => createShellVmCli(defaultVmScript(config.vmScripts.cli))
  const windowsHypervisor =
    options.windowsHypervisor !== undefined
      ? options.windowsHypervisor
      : process.platform === 'win32'
        ? new WindowsHypervisorProbe()
        : null

  const publishWorkspace = (workspace: Workspace): WorkspaceSummary => {
    const summary = summarize(workspace)
    hub.publishApp({ type: 'workspace.updated', payload: { workspace: summary } })
    hub.publishWorkspace(workspace.id, { type: 'workspace.updated', payload: { workspace: summary } })
    return summary
  }

  const golden = new GoldenBuilder({
    dataRoot: options.dataRoot,
    golden: goldenImage,
    script: config.vmScripts.build,
    // Windows without a usable hypervisor (as last seen by GET /host): build with TCG instead of failing.
    accelEnv: (): Record<string, string> =>
      windowsHypervisor && !whpxUsable(windowsHypervisor.lastKnown()) ? { MILIBOT_VM_ACCEL: 'tcg' } : {},
    onStatus: (status) => hub.publishApp({ type: 'golden.status', payload: { status } }),
    // Workspaces whose setup was waiting for the image create their VM now (the others boot it on open).
    onReady: () => {
      for (const workspace of store.listWorkspaces()) {
        if (workspace.setup !== 'vm' || !runtimes.isRunning(workspace.id)) continue
        requestRuntime(workspace, 'startVm').catch((err: unknown) =>
          app.log.warn({ err, workspaceId: workspace.id }, 'setup VM start failed'),
        )
      }
    },
    log: logFn(app.log),
  })
  golden.resume()

  const target = (workspace: Workspace) => ({
    id: workspace.id,
    dir: workspace.dir,
    name: workspace.name,
    vmPortBase: store.vmPortBase(workspace.id),
    closeBehavior: workspace.closeBehavior,
  })

  /** A workspace endpoint without path params besides the workspace, called by the supervisor itself. */
  const requestRuntime = (workspace: Workspace, name: WorkspaceEndpointName, body: unknown = {}) =>
    runtimes.request(
      target(workspace),
      store.getSettings().language,
      name,
      { workspaceId: workspace.id },
      {},
      body,
    )

  const appHandlers: AppHandlers = {
    health: () => ({ ok: true, pid: process.pid, version: DAEMON_VERSION, startedAt }),

    getAppSettings: () => store.getSettings(),

    updateAppSettings: ({ body }) => {
      const previous = store.getSettings().language
      const settings = store.updateSettings(body)
      hub.publishApp({ type: 'app_settings.updated', payload: { settings } })
      if (settings.language !== previous) shareUserLanguage()
      return settings
    },

    listWorkspaces: () => store.listWorkspaces().map(summarize),

    listWorkspaceOverviews: () => store.listWorkspaces().map(workspaceOverview),

    getHostInfo: async () => ({
      ...hostInfo(goldenImage(), windowsHypervisor ? await windowsHypervisor.get() : undefined),
      ...(options.secretStoreInfo ? hostSecretStore(options.secretStoreInfo) : {}),
      setup: hostSetup(systemHostProbe()),
    }),

    shutdown: ({ reply }) => {
      // Let the response reach the client before the server closes.
      reply.raw.once('finish', () => options.requestShutdown?.('api'))
      return { ok: true }
    },

    getGoldenImage: () => golden.status(),
    buildGoldenImage: () => golden.build(),

    ...createWorkspaceHandlers({
      paths,
      store,
      runtimes,
      hub,
      golden,
      secretStore: options.secretStore,
      vmCli,
      log: app.log,
      summarize,
      publishWorkspace,
      target,
      requestRuntime,
    }),
  }

  /** Running runtimes learn the new app language now; the others get it when they start (`seedWorkspace`). */
  const shareUserLanguage = () => {
    const language = store.getSettings().language
    for (const workspace of store.listWorkspaces()) {
      if (!runtimes.isRunning(workspace.id)) continue
      requestRuntime(workspace, 'updateWorkspacePreferences', { userLanguage: language }).catch(
        (err: unknown) =>
          app.log.warn({ err, workspaceId: workspace.id }, 'user language not sent to the runtime'),
      )
    }
  }

  const portConflicts = new Set<string>()
  const portMoves = new Map<string, number>()

  /**
   * Another program holds ports of a workspace VM's range (the VM start failed with `PORT_IN_USE`): the VM
   * moves to the next free range and boots again, a few times per daemon session at most.
   */
  const watchPortConflict = (workspaceId: string, errorCode: string | undefined) => {
    if (errorCode !== 'PORT_IN_USE') {
      portConflicts.delete(workspaceId)
      return
    }
    const moves = portMoves.get(workspaceId) ?? 0
    if (portConflicts.has(workspaceId) || moves >= MAX_PORT_MOVES) return
    portConflicts.add(workspaceId)
    portMoves.set(workspaceId, moves + 1)
    const workspace = store.findWorkspace(workspaceId)
    if (!workspace) return
    void (async () => {
      const base = store.moveVmPortBase(workspaceId)
      await vmCli().run(['resize', workspace.dir, '--port-base', String(base)], {
        timeoutMs: 20_000,
      })
      app.log.warn({ workspaceId, base }, 'VM ports in use; moved the VM to another port range')
      await requestRuntime(workspace, 'startVm')
    })().catch((err: unknown) => app.log.warn({ err, workspaceId }, 'could not move the VM to other ports'))
  }

  registerRoutes(app, {
    hub,
    appHandlers,
    workspaceExists: (workspaceId) => store.findWorkspace(workspaceId) !== null,
    runtimeStatus: (workspaceId) => runtimes.status(workspaceId),
    forward: (name, params, query, body) => {
      const workspaceId = params.workspaceId
      if (!workspaceId) throw new DaemonError('validation_failed', 'Missing workspace id')
      const workspace = store.getWorkspace(workspaceId)
      return runtimes.request(target(workspace), store.getSettings().language, name, params, query, body)
    },
  })

  return {
    app,
    token,
    store,
    runtimes,
    embeddingModels,
    async listen(port) {
      await app.listen({ host: '127.0.0.1', port })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Unexpected server address')
      return address.port
    },
    async autoStartRuntimes() {
      const workspaces = store.listWorkspaces()
      const lastRunning = store.lastRunningIds()
      const selected = new Set(
        selectAutoStart(
          workspaces.map((w) => ({
            id: w.id,
            setup: w.setup,
            closeBehavior: w.closeBehavior,
            lastRunning: lastRunning.has(w.id),
            enabledRoutines: lastRunning.has(w.id) ? countEnabledRoutines(workspacePaths(w.dir).db) : 0,
          })),
        ),
      )
      for (const workspace of workspaces) {
        if (!selected.has(workspace.id)) store.setLastRunning(workspace.id, false)
      }
      const language = store.getSettings().language
      const started = await Promise.all(
        workspaces
          .filter((w) => selected.has(w.id))
          .map((workspace) =>
            runtimes.ensure({ ...target(workspace), background: true }, language).then(
              () => workspace.id,
              (err: unknown) => {
                app.log.warn({ err, workspaceId: workspace.id }, 'runtime auto-start failed')
                return null
              },
            ),
          ),
      )
      const ids = started.filter((id): id is string => id !== null)
      if (ids.length) app.log.info({ workspaceIds: ids }, 'runtimes started in the background')
      return ids
    },
    async close() {
      golden.close()
      hub.closeAll()
      await runtimes.stopAll((id) =>
        store.findWorkspace(id)?.closeBehavior === 'suspend_vm' ? 'stop' : 'keep',
      )
      runtimeCalls.dropAll()
      await embeddingModels.close()
      await app.close()
      store.close()
    },
  }
}
