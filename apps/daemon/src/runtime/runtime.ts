import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AgentHost, createNoopAgentHost } from '@milibot/agent'
import type { CloseBehavior, LogFn, WorkspaceEvent } from '@milibot/shared'

import type { Db } from '../db/sqlite'
import type { VmShutdownMode, WorkspaceEndpointName } from '../ipc/protocol'
import { MemorySecretStore, type SecretStore } from '../secrets/secret-store'
import { type Container, createContainer, type RuntimeOverrides } from './composition/container'
import { dispatch } from './composition/routes'
import { createPlaceholderVm, type VmController } from './vm/controller'
import type { WorkspaceStore } from './workspace-store'

export interface WorkspaceRuntimeOptions {
  workspaceId: string
  db: Db
  emit: (event: WorkspaceEvent) => void
  /** Workspace directory (debug blobs live under it); defaults to a temp dir for tests. */
  workspaceDir?: string
  /** Workspace name shown in the VM and in backups (default: the workspace id). */
  workspaceName?: string
  agentHost?: AgentHost
  vm?: VmController
  now?: () => number
  secrets?: SecretStore
  version?: string
  /** `MILIBOT_FAKE_LLM`: every provider becomes this script's `FakeProvider`. */
  fakeScriptPath?: string | null
  vmAutostart?: boolean | (() => boolean)
  enableCliEngines?: boolean
  /** The workspace's "on close" setting; absent: no VM to manage. */
  closeBehavior?: () => CloseBehavior
  log?: LogFn
  /** The daemon's log file `daemon_logs` reads; absent: none (the daemon runs from a terminal, tests). */
  daemonLogPath?: string | null
  overrides?: RuntimeOverrides
}

export interface WorkspaceRuntime {
  readonly store: WorkspaceStore
  readonly services: Container
  handle(
    endpoint: WorkspaceEndpointName,
    params: Record<string, string>,
    query: unknown,
    body: unknown,
  ): Promise<unknown>
  start(): Promise<void>
  /** `vm`: what to do with a running workspace VM (default: leave it running). */
  stop(vm?: VmShutdownMode): Promise<void>
}

export function createWorkspaceRuntime(options: WorkspaceRuntimeOptions): WorkspaceRuntime {
  const services = createContainer({
    workspaceId: options.workspaceId,
    workspaceDir: options.workspaceDir ?? join(tmpdir(), `milibot-${options.workspaceId}`),
    workspaceName: options.workspaceName ?? options.workspaceId,
    db: options.db,
    emit: options.emit,
    now: options.now ?? Date.now,
    secrets: options.secrets ?? new MemorySecretStore(),
    vm: options.vm ?? createPlaceholderVm(),
    host: options.agentHost ?? createNoopAgentHost(),
    version: options.version ?? 'dev',
    fakeScriptPath: options.fakeScriptPath ?? null,
    vmAutostart:
      typeof options.vmAutostart === 'function' ? options.vmAutostart : () => options.vmAutostart === true,
    enableCliEngines: options.enableCliEngines ?? false,
    closeBehavior: options.closeBehavior ?? null,
    log: options.log ?? (() => {}),
    daemonLogPath: options.daemonLogPath ?? null,
    overrides: options.overrides ?? {},
  })
  return {
    store: services.store,
    services,
    handle: async (endpoint, params, query, body) =>
      dispatch(services.handlers, endpoint, params, query, body),
    start: () => services.start(),
    stop: (vm = 'keep') => services.stop(vm),
  }
}
