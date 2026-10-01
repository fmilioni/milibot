import { type AgentHostOptions, createAgentHost, type DefaultAgentHost } from '@milibot/agent'
import { FakeProvider, type FakeScript, type FakeStep } from '@milibot/agent/testing'
import type { Language, Message, WorkspaceEvent } from '@milibot/shared'

import type { Db } from '../../src/db/sqlite'
import type { RuntimeOverrides } from '../../src/runtime/composition/container'
import {
  createWorkspaceRuntime,
  type WorkspaceRuntime,
  type WorkspaceRuntimeOptions,
} from '../../src/runtime/runtime'
import { QemuVmController, type QemuVmOptions } from '../../src/runtime/vm/controller'
import type { WorkspaceStore } from '../../src/runtime/workspace-store'
import { MemorySecretStore } from '../../src/secrets/secret-store'
import { openWorkspaceDb } from '../../src/workspace-db/open'
import { seedWorkspace } from '../../src/workspace-db/seed'
import { type FakeGuest, fakeGuest } from './fake-guest'
import { FakeVmCli } from './fake-vm-cli'
import { until } from './wait'

export const TEST_WORKSPACE_ID = 'ws_test'

export interface BootRuntimeOptions {
  /** Workspace directory (usually the test's temp dir). */
  dir: string
  workspaceId?: string
  /** Script of the FakeProvider that replaces every configured provider (ignored with `provider`). */
  script?: FakeScript
  fallback?: FakeStep
  provider?: FakeProvider
  host?: AgentHostOptions
  /**
   * A fake VM (FakeVmCli + fake guest) that boots with the runtime and is running when `bootRuntime` returns
   * (default); `false` runs without a VM; `autostart: false` leaves it stopped.
   */
  vm?: false | { autostart?: boolean; cli?: FakeVmCli; options?: Partial<QemuVmOptions> }
  guest?: FakeGuest
  secrets?: MemorySecretStore
  /** Reuse a database (e.g. to restart a runtime); default: a fresh in-memory one. */
  db?: Db
  /** Language the workspace is seeded in (the first bot's defaults). */
  language?: Language
  runtime?: Partial<WorkspaceRuntimeOptions>
  overrides?: RuntimeOverrides
}

export interface RuntimeHarness {
  runtime: WorkspaceRuntime
  store: WorkspaceStore
  db: Db
  host: DefaultAgentHost
  provider: FakeProvider
  guest: FakeGuest
  vm: QemuVmController | null
  secrets: MemorySecretStore
  events: WorkspaceEvent[]
  workspaceId: string
  /** The first bot and its direct conversation. */
  botId: string
  dm: string
  call<T = unknown>(
    endpoint: Parameters<WorkspaceRuntime['handle']>[0],
    params?: Record<string, string>,
    body?: unknown,
    query?: unknown,
  ): Promise<T>
  messages(conversationId?: string): Message[]
  stop(): Promise<void>
}

const booted: RuntimeHarness[] = []

/** Stops every runtime booted since the last call (register with `afterEach`). */
export async function stopRuntimes(): Promise<void> {
  for (const harness of booted.splice(0)) await harness.stop()
}

export async function bootRuntime(options: BootRuntimeOptions): Promise<RuntimeHarness> {
  const workspaceId = options.workspaceId ?? TEST_WORKSPACE_ID
  const db = options.db ?? openWorkspaceDb(':memory:')
  const events: WorkspaceEvent[] = []
  const guest = options.guest ?? fakeGuest()
  const secrets = options.secrets ?? new MemorySecretStore()
  const host = createAgentHost({ deltaFlushMs: 1, ...options.host })
  const provider =
    options.provider ??
    new FakeProvider({
      script: options.script ?? [],
      ...(options.fallback ? { fallback: options.fallback } : {}),
    })
  let store: WorkspaceStore | null = null
  const vmOptions = options.vm === false ? null : (options.vm ?? {})
  const vm = vmOptions
    ? new QemuVmController({
        workspaceDir: options.dir,
        workspaceName: 'test',
        portBase: 47400,
        cli: vmOptions.cli ?? new FakeVmCli(),
        golden: () => '/images/debian13-golden.qcow2',
        settings: () => ({ cpus: 2, memGb: 4, dataGb: 20, systemGb: 30 }),
        bots: () => store?.bots.list() ?? [],
        pendingRemovals: () => store?.bots.pendingRemovals() ?? [],
        onBotRemoved: (slug) => store?.bots.markRemovedFromVm(slug),
        emit: (info) => events.push({ type: 'vm.status', payload: { vm: info } }),
        guestFactory: guest.client,
        pollIntervalMs: 5,
        ...vmOptions.options,
      })
    : null
  const autostart = vmOptions?.autostart ?? true
  const runtime = createWorkspaceRuntime({
    workspaceId,
    workspaceDir: options.dir,
    db,
    emit: (event) => events.push(event),
    ...(vm ? { vm, vmAutostart: autostart } : {}),
    agentHost: host,
    secrets,
    ...options.runtime,
    overrides: { llm: provider, ...options.overrides },
  })
  store = runtime.store
  const seeded = seedWorkspace(runtime.store, options.language ?? 'en')
  let stopped = false
  const harness: RuntimeHarness = {
    runtime,
    store: runtime.store,
    db,
    host,
    provider,
    guest,
    vm,
    secrets,
    events,
    workspaceId,
    botId: seeded.botId,
    dm: seeded.conversationId,
    call: (endpoint, params = {}, body, query) =>
      runtime.handle(endpoint, { workspaceId, ...params }, query ?? {}, body) as Promise<never>,
    messages: (conversationId = seeded.conversationId) =>
      runtime.store.messages.list(conversationId, { limit: 200 }).messages,
    stop: async () => {
      if (stopped) return
      stopped = true
      await runtime.stop('force')
    },
  }
  booted.push(harness)
  await runtime.start()
  if (vm && autostart) await until(() => vm.info().state === 'running', 8000)
  return harness
}
