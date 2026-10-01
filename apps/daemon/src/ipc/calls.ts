import { errorMessage } from '../errors'
import type { RuntimeCallMap, RuntimeCallMethod, RuntimeToSupervisor, SupervisorToRuntime } from './protocol'

const DEFAULT_CALL_TIMEOUT_MS = 60_000

/** A failed runtime → supervisor call: the handler's error code, or `aborted`/`timeout`/`disconnected`. */
export class RuntimeCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RuntimeCallError'
  }
}

export interface RuntimeCallOptions<P> {
  signal?: AbortSignal
  /** Fails the call after this long without a result or progress (default `DEFAULT_CALL_TIMEOUT_MS`). */
  timeoutMs?: number
  onProgress?: (progress: P) => void
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (err: RuntimeCallError) => void
  progress: (progress: unknown) => void
}

type Send<T> = (message: T, callback: (err: Error | null) => void) => void

/** Runtime side of the calls: sends `call`, waits for `call_result`, cancels on abort or timeout. */
export class SupervisorCallClient {
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private closed: string | null = null

  constructor(private readonly send: Send<RuntimeToSupervisor>) {}

  call<M extends RuntimeCallMethod>(
    method: M,
    args: RuntimeCallMap[M]['args'],
    options: RuntimeCallOptions<RuntimeCallMap[M]['progress']> = {},
  ): Promise<RuntimeCallMap[M]['result']> {
    const { signal } = options
    if (this.closed) return Promise.reject(new RuntimeCallError('disconnected', this.closed))
    if (signal?.aborted) return Promise.reject(new RuntimeCallError('aborted', `${method} aborted`))
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const finish = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
      }
      const giveUp = (err: RuntimeCallError) => {
        if (!this.pending.has(id)) return
        finish()
        this.send({ type: 'call_cancel', id }, () => undefined)
        reject(err)
      }
      const arm = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(
          () => giveUp(new RuntimeCallError('timeout', `${method} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        )
        timer.unref()
      }
      const onAbort = () => giveUp(new RuntimeCallError('aborted', `${method} aborted`))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (result) => {
          finish()
          resolve(result as RuntimeCallMap[M]['result'])
        },
        reject: (err) => {
          finish()
          reject(err)
        },
        progress: (progress) => {
          arm()
          options.onProgress?.(progress as RuntimeCallMap[M]['progress'])
        },
      })
      arm()
      try {
        this.send({ type: 'call', id, method, args }, (err) => {
          if (err) this.pending.get(id)?.reject(new RuntimeCallError('disconnected', err.message))
        })
      } catch (err) {
        this.pending.get(id)?.reject(new RuntimeCallError('disconnected', errorMessage(err)))
      }
    })
  }

  /** Handles `call_result`/`call_progress`; false for any other message. */
  handle(message: SupervisorToRuntime): boolean {
    if (message.type === 'call_progress') {
      this.pending.get(message.id)?.progress(message.progress)
      return true
    }
    if (message.type !== 'call_result') return false
    const pending = this.pending.get(message.id)
    if (!pending) return true
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new RuntimeCallError(message.error.code, message.error.message))
    return true
  }

  /** The channel is gone: pending and future calls fail with `disconnected`. */
  close(reason = 'supervisor disconnected'): void {
    this.closed = reason
    for (const pending of [...this.pending.values()])
      pending.reject(new RuntimeCallError('disconnected', reason))
  }
}

export interface RuntimeCallContext<P> {
  /** Caller id (one per runtime process); also the fairness key of shared queues. */
  client: string
  /** Aborted when the caller cancels or its runtime exits. */
  signal: AbortSignal
  progress: (progress: P) => void
}

export type RuntimeCallHandlers = {
  [M in RuntimeCallMethod]?: (
    args: RuntimeCallMap[M]['args'],
    context: RuntimeCallContext<RuntimeCallMap[M]['progress']>,
  ) => Promise<RuntimeCallMap[M]['result']>
}

/** Supervisor side of the calls: runs the handler, relays progress, drops the calls of a runtime that exits. */
export class RuntimeCallServer {
  private readonly clients = new Map<string, Map<number, AbortController>>()

  constructor(private readonly handlers: RuntimeCallHandlers) {}

  /** Calls in progress (all clients, or one). */
  active(client?: string): number {
    if (client !== undefined) return this.clients.get(client)?.size ?? 0
    let total = 0
    for (const calls of this.clients.values()) total += calls.size
    return total
  }

  /** Handles `call`/`call_cancel`; false for any other message. */
  handle(
    client: string,
    message: RuntimeToSupervisor,
    reply: (message: SupervisorToRuntime) => void,
  ): boolean {
    if (message.type === 'call_cancel') {
      const calls = this.clients.get(client)
      const controller = calls?.get(message.id)
      if (controller) {
        calls?.delete(message.id)
        controller.abort()
      }
      return true
    }
    if (message.type !== 'call') return false
    const { id, method } = message
    const handler = this.handlers[method] as
      ((args: unknown, context: RuntimeCallContext<unknown>) => Promise<unknown>) | undefined
    if (!handler) {
      reply({
        type: 'call_result',
        id,
        ok: false,
        error: { code: 'unknown_method', message: `unknown call ${method}` },
      })
      return true
    }
    let calls = this.clients.get(client)
    if (!calls) {
      calls = new Map()
      this.clients.set(client, calls)
    }
    const controller = new AbortController()
    calls.set(id, controller)
    const live = () => this.clients.get(client)?.get(id) === controller
    const done = () => {
      if (!live()) return false
      calls.delete(id)
      if (calls.size === 0) this.clients.delete(client)
      return true
    }
    Promise.resolve()
      .then(() =>
        handler(message.args, {
          client,
          signal: controller.signal,
          progress: (progress) => {
            if (live()) reply({ type: 'call_progress', id, progress })
          },
        }),
      )
      .then(
        (result) => {
          if (done()) reply({ type: 'call_result', id, ok: true, result })
        },
        (err: unknown) => {
          if (!done()) return
          const code =
            typeof (err as { code?: unknown })?.code === 'string'
              ? (err as { code: string }).code
              : 'internal'
          const text = err instanceof Error ? err.message : String(err)
          reply({ type: 'call_result', id, ok: false, error: { code, message: text } })
        },
      )
    return true
  }

  /** The runtime exited: its calls are aborted and never answered. */
  dropClient(client: string): void {
    const calls = this.clients.get(client)
    if (!calls) return
    this.clients.delete(client)
    for (const controller of calls.values()) controller.abort()
  }

  dropAll(): void {
    for (const client of [...this.clients.keys()]) this.dropClient(client)
  }
}
