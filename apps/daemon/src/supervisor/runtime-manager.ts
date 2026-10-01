import { type ChildProcess, fork } from 'node:child_process'

import type { CloseBehavior, Language, LogFn, RuntimeStatus, WorkspaceEvent } from '@milibot/shared'

import { DaemonError } from '../errors'
import type { RuntimeCallServer } from '../ipc/calls'
import {
  RUNTIME_ENV,
  type RuntimeToSupervisor,
  type SupervisorToRuntime,
  type VmShutdownMode,
  type WorkspaceEndpointName,
} from '../ipc/protocol'

export interface RuntimeLauncher {
  /** Absolute path of the runtime entry (runtime-main.ts in dev, runtime-main.js when bundled). */
  entry: string
  execArgv: string[]
  env?: Record<string, string>
}

export interface RuntimeTarget {
  id: string
  dir: string
  name?: string
  vmPortBase?: number
  closeBehavior?: CloseBehavior
  /** Started by the daemon on its own, with no window open. */
  background?: boolean
}

export interface RuntimeManagerOptions {
  launcher: RuntimeLauncher
  onEvent: (workspaceId: string, event: WorkspaceEvent) => void
  onStatus: (workspaceId: string, status: RuntimeStatus) => void
  log: LogFn
  /** Services the runtimes call (`call` messages); without it every call fails with `unknown_method`. */
  calls?: RuntimeCallServer
  readyTimeoutMs?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface RuntimeProcess {
  workspaceId: string
  child: ChildProcess
  status: RuntimeStatus
  ready: Promise<void>
  pending: Map<number, Pending>
  stopping: boolean
  exited: Promise<void>
}

/** One caller per runtime process (a restarted runtime never receives answers meant for the old one). */
function callClient(proc: RuntimeProcess): string {
  return `${proc.workspaceId}#${proc.child.pid ?? 0}`
}

export class RuntimeManager {
  private readonly processes = new Map<string, RuntimeProcess>()
  private readonly lastStatus = new Map<string, RuntimeStatus>()
  private nextRequestId = 1

  constructor(private readonly options: RuntimeManagerOptions) {}

  status(workspaceId: string): RuntimeStatus {
    return this.processes.get(workspaceId)?.status ?? this.lastStatus.get(workspaceId) ?? 'stopped'
  }

  pid(workspaceId: string): number | null {
    return this.processes.get(workspaceId)?.child.pid ?? null
  }

  async ensure(workspace: RuntimeTarget, language: Language): Promise<void> {
    const existing = this.processes.get(workspace.id)
    if (existing && !existing.stopping) return existing.ready
    if (existing) await existing.exited
    return this.spawn(workspace, language).ready
  }

  private setStatus(proc: RuntimeProcess, status: RuntimeStatus): void {
    if (proc.status === status) return
    proc.status = status
    this.lastStatus.set(proc.workspaceId, status)
    this.options.onStatus(proc.workspaceId, status)
  }

  private spawn(workspace: RuntimeTarget, language: Language): RuntimeProcess {
    const { launcher, log } = this.options
    const child = fork(launcher.entry, [], {
      execArgv: launcher.execArgv,
      windowsHide: true,
      env: {
        ...process.env,
        ...launcher.env,
        [RUNTIME_ENV.workspaceId]: workspace.id,
        [RUNTIME_ENV.workspaceDir]: workspace.dir,
        [RUNTIME_ENV.language]: language,
        ...(workspace.name ? { [RUNTIME_ENV.workspaceName]: workspace.name } : {}),
        ...(workspace.vmPortBase ? { [RUNTIME_ENV.vmPortBase]: String(workspace.vmPortBase) } : {}),
        ...(workspace.background ? { [RUNTIME_ENV.background]: '1' } : {}),
        ...(workspace.closeBehavior ? { [RUNTIME_ENV.closeBehavior]: workspace.closeBehavior } : {}),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })

    let markReady!: () => void
    let failReady!: (error: Error) => void
    let markExited!: () => void
    const proc: RuntimeProcess = {
      workspaceId: workspace.id,
      child,
      status: 'stopped',
      pending: new Map(),
      stopping: false,
      ready: new Promise<void>((resolve, reject) => {
        markReady = resolve
        failReady = reject
      }),
      exited: new Promise<void>((resolve) => (markExited = resolve)),
    }
    proc.ready.catch(() => undefined)
    this.processes.set(workspace.id, proc)
    this.setStatus(proc, 'starting')

    const readyTimer = setTimeout(() => {
      failReady(new DaemonError('runtime_unavailable', 'Workspace runtime did not become ready in time'))
      child.kill('SIGKILL')
    }, this.options.readyTimeoutMs ?? 20_000)

    child.on('message', (message: RuntimeToSupervisor) => {
      switch (message.type) {
        case 'ready':
          clearTimeout(readyTimer)
          this.setStatus(proc, 'running')
          markReady()
          break
        case 'response': {
          const pending = proc.pending.get(message.id)
          if (!pending) return
          proc.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.ok) pending.resolve(message.result)
          else
            pending.reject(new DaemonError(message.error.code, message.error.message, message.error.details))
          break
        }
        case 'event':
          this.options.onEvent(workspace.id, message.event)
          break
        case 'call':
        case 'call_cancel':
          this.handleCall(proc, message)
          break
      }
    })

    child.on('error', (err) =>
      log('error', 'runtime process error', { workspaceId: workspace.id, err: err.message }),
    )

    child.on('exit', (code, signal) => {
      clearTimeout(readyTimer)
      const crashed = !proc.stopping
      if (crashed) log('warn', 'runtime exited unexpectedly', { workspaceId: workspace.id, code, signal })
      failReady(new DaemonError('runtime_unavailable', 'Workspace runtime exited during startup'))
      for (const pending of proc.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new DaemonError('runtime_unavailable', 'Workspace runtime exited'))
      }
      proc.pending.clear()
      this.options.calls?.dropClient(callClient(proc))
      if (this.processes.get(workspace.id) === proc) this.processes.delete(workspace.id)
      this.setStatus(proc, crashed ? 'crashed' : 'stopped')
      markExited()
    })

    return proc
  }

  private handleCall(
    proc: RuntimeProcess,
    message: Extract<RuntimeToSupervisor, { type: 'call' | 'call_cancel' }>,
  ) {
    const reply = (answer: SupervisorToRuntime) => {
      if (proc.child.connected) proc.child.send(answer, () => undefined)
    }
    if (this.options.calls) {
      this.options.calls.handle(callClient(proc), message, reply)
    } else if (message.type === 'call') {
      reply({
        type: 'call_result',
        id: message.id,
        ok: false,
        error: { code: 'unknown_method', message: `unknown call ${message.method}` },
      })
    }
  }

  async request(
    workspace: RuntimeTarget,
    language: Language,
    endpoint: WorkspaceEndpointName,
    params: Record<string, string>,
    query: unknown,
    body: unknown,
  ): Promise<unknown> {
    await this.ensure(workspace, language)
    const proc = this.processes.get(workspace.id)
    if (!proc || proc.status !== 'running') {
      throw new DaemonError('runtime_unavailable', 'Workspace runtime is not running')
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.pending.delete(id)
        reject(new DaemonError('runtime_unavailable', `Runtime request timed out: ${endpoint}`))
      }, this.options.requestTimeoutMs ?? 30_000)
      proc.pending.set(id, { resolve, reject, timer })
      const message: SupervisorToRuntime = { type: 'request', id, endpoint, params, query, body }
      proc.child.send(message, (err) => {
        if (!err) return
        clearTimeout(timer)
        proc.pending.delete(id)
        reject(new DaemonError('runtime_unavailable', err.message))
      })
    })
  }

  /** Tells the runtime a window opened its workspace. */
  opened(workspaceId: string): void {
    const proc = this.processes.get(workspaceId)
    if (!proc || proc.stopping || !proc.child.connected) return
    proc.child.send({ type: 'opened' } satisfies SupervisorToRuntime, () => undefined)
  }

  closeBehaviorChanged(workspaceId: string, closeBehavior: CloseBehavior): void {
    const proc = this.processes.get(workspaceId)
    if (!proc || proc.stopping || !proc.child.connected) return
    proc.child.send({ type: 'close_behavior', closeBehavior } satisfies SupervisorToRuntime, () => undefined)
  }

  isRunning(workspaceId: string): boolean {
    const proc = this.processes.get(workspaceId)
    return Boolean(proc && !proc.stopping && proc.status === 'running')
  }

  /** Stopping the VM (graceful ACPI shutdown) can take a while, so the kill timeout grows with it. */
  async stop(workspaceId: string, options: { vm?: VmShutdownMode; timeoutMs?: number } = {}): Promise<void> {
    const proc = this.processes.get(workspaceId)
    if (!proc) return
    const vm = options.vm ?? 'keep'
    const timeoutMs = options.timeoutMs ?? (vm === 'stop' ? 75_000 : vm === 'force' ? 15_000 : 5_000)
    proc.stopping = true
    if (proc.child.connected) {
      proc.child.send({ type: 'shutdown', vm } satisfies SupervisorToRuntime, () => undefined)
    } else {
      proc.child.kill('SIGTERM')
    }
    const timer = setTimeout(() => proc.child.kill('SIGKILL'), timeoutMs)
    await proc.exited
    clearTimeout(timer)
  }

  async stopAll(vmFor: (workspaceId: string) => VmShutdownMode = () => 'keep'): Promise<void> {
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id, { vm: vmFor(id) })))
  }
}
