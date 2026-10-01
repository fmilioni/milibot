import { AsyncQueue } from '../cli/async-queue'
import type { GuestCliBackend, GuestProcSpec } from '../cli/backend'
import type { CliLog } from '../cli/engine'
import { GuestProcess, type GuestProcessExit } from '../cli/guest-process'
import { KILL_GRACE_MS } from '../cli/process'
import type { RequestId, RpcError, ServerNotification, ServerRequest } from './protocol'

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpc: RpcError,
  ) {
    super(`${method}: ${rpc.message}`)
  }
}

export type RpcItem =
  { type: 'notification'; message: ServerNotification } | ({ type: 'exit' } & GuestProcessExit)

/** What to answer a request the server sends (approvals, questions to the user…). */
export type ServerRequestHandler = (request: ServerRequest) => { result: unknown } | { error: RpcError }

const DEFAULT_TIMEOUT_MS = 60_000

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One `codex app-server` process in the VM: requests matched to their answers by id, notifications queued in
 * order, requests from the server answered by `onServerRequest`.
 */
export class CodexRpc {
  readonly items = new AsyncQueue<RpcItem>()
  private nextId = 1
  private readonly pending = new Map<RequestId, Pending>()

  private constructor(
    private readonly proc: GuestProcess,
    private readonly onServerRequest: ServerRequestHandler,
    private readonly log: CliLog,
  ) {}

  static async start(
    backend: GuestCliBackend,
    spec: GuestProcSpec,
    onServerRequest: ServerRequestHandler,
    log: CliLog = () => {},
    killGraceMs = KILL_GRACE_MS,
  ): Promise<CodexRpc> {
    const proc = await GuestProcess.start(backend, spec, { log, killGraceMs })
    const rpc = new CodexRpc(proc, onServerRequest, log)
    proc.listen({ line: (text) => rpc.dispatch(text), exit: (exit) => rpc.exited(exit) })
    return rpc
  }

  /** False once the process exited or was closed. */
  get alive(): boolean {
    return this.proc.alive
  }

  request<T>(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.alive) return Promise.reject(new Error(`codex exited before ${method}`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex did not answer ${method} in ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      this.write({ method, id, params }).catch((err: unknown) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err as Error)
      })
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  /** `initialize` + `initialized`; the experimental API is needed for per-thread config and `turn/steer`. */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'milibot', title: 'Milibot', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    await this.notify('initialized')
  }

  /** `force`: SIGKILL at once (the process already ignored a stop). */
  async close(force = false): Promise<void> {
    this.failPending('codex process closed')
    await this.proc.close(force)
  }

  private write(message: Record<string, unknown>): Promise<void> {
    return this.proc.write(`${JSON.stringify(message)}\n`)
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(`${reason} (while waiting for ${p.method})`))
      this.pending.delete(id)
    }
  }

  private exited(exit: GuestProcessExit): void {
    const why = exit.stderr.trim().slice(-300)
    this.failPending(`codex exited (code ${exit.code ?? 'null'})${why ? `: ${why}` : ''}`)
    this.items.push({ type: 'exit', ...exit })
  }

  private dispatch(text: string): void {
    if (!text.trim()) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      this.log('codex wrote a line that is not JSON', { line: text.slice(0, 200) })
      return
    }
    const id = message.id as RequestId | undefined
    const method = typeof message.method === 'string' ? message.method : null
    if (id !== undefined && method === null) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new CodexRpcError(pending.method, message.error as RpcError))
      else pending.resolve(message.result)
      return
    }
    if (id !== undefined && method !== null) {
      const answer = this.onServerRequest({ id, method, params: message.params })
      void this.write({ id, ...answer }).catch(() => undefined)
      return
    }
    if (method !== null) this.items.push({ type: 'notification', message: message as ServerNotification })
  }
}
