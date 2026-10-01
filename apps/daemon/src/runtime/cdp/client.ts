import type { GuestProcEvent } from '@milibot/agent/cli'

import { RELAY_SCRIPT } from './scripts/relay.generated'

/** A line-oriented byte pipe to the relay. */
export interface LineChannel {
  start(onLine: (line: string) => void, onClose: (reason: string) => void): Promise<void>
  send(line: string): Promise<void>
  close(): Promise<void>
}

/** Guest agent process API, as the daemon uses it. */
export interface RelayProcBackend {
  startProc(spec: {
    user: string
    argv: string[]
    cwd: string
    env: Record<string, string>
    label: string
  }): Promise<{ id: string }>
  procEvents(id: string, since: number, signal: AbortSignal): AsyncIterable<GuestProcEvent>
  procStdin(id: string, data: string, eof?: boolean): Promise<unknown>
  procSignal(id: string, signal: string): Promise<unknown>
}

/** The relay as a guest agent process (`/procs`), its stdout streamed back and resumed by sequence number. */
export class GuestRelayChannel implements LineChannel {
  private id: string | null = null
  private readonly pump = new AbortController()
  private closed = false
  private writes: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly backend: () => RelayProcBackend,
    private readonly options: { port: number; label: string },
  ) {}

  async start(onLine: (line: string) => void, onClose: (reason: string) => void): Promise<void> {
    const { id } = await this.backend().startProc({
      user: 'agent',
      argv: ['node', '-e', RELAY_SCRIPT],
      cwd: '/',
      env: { CDP_PORT: String(this.options.port) },
      label: this.options.label,
    })
    this.id = id
    void this.read(id, onLine, onClose)
  }

  private async read(id: string, onLine: (line: string) => void, onClose: (reason: string) => void) {
    let since = 0
    let failures = 0
    let partial = ''
    let stderr = ''
    while (!this.closed) {
      try {
        for await (const event of this.backend().procEvents(id, since, this.pump.signal)) {
          if ('seq' in event) since = event.seq
          failures = 0
          if (event.type === 'stdout') {
            if (event.partial) partial += event.data
            else {
              onLine(partial + event.data)
              partial = ''
            }
          } else if (event.type === 'stderr') stderr = (stderr + event.data + '\n').slice(-2000)
          else if (event.type === 'exit') {
            this.closed = true
            onClose(
              stderr.trim()
                ? `relay exited: ${stderr.trim().split('\n').slice(-3).join(' ')}`
                : 'relay exited',
            )
            return
          }
        }
      } catch (err) {
        if (this.closed) return
        if (++failures >= 5) {
          this.closed = true
          onClose(`lost the relay: ${(err as Error).message}`)
          return
        }
      }
      if (!this.closed) await new Promise((r) => setTimeout(r, 500))
    }
  }

  send(line: string): Promise<void> {
    const id = this.id
    if (!id || this.closed) return Promise.reject(new Error('browser connection is closed'))
    const write = this.writes.then(() => this.backend().procStdin(id, `${line}\n`))
    this.writes = write.catch(() => undefined)
    return write.then(() => undefined)
  }

  async close(): Promise<void> {
    if (this.closed && !this.id) return
    this.closed = true
    this.pump.abort()
    const id = this.id
    this.id = null
    if (id) {
      await this.backend()
        .procStdin(id, '', true)
        .catch(() => undefined)
      await this.backend()
        .procSignal(id, 'SIGTERM')
        .catch(() => undefined)
    }
  }
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message)
    this.name = 'CdpError'
  }
}

export interface TabInfo {
  id: string
  type: string
  title: string
  url: string
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

/** Chrome DevTools Protocol over a relay line channel (browser-level connection, flat sessions). */
export class CdpClient {
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly relayPending = new Map<number, Pending>()
  private readonly listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>()
  private opened: { resolve: () => void; reject: (err: Error) => void } | null = null
  private closedReason: string | null = null

  constructor(private readonly channel: LineChannel) {}

  get closed(): boolean {
    return this.closedReason !== null
  }

  /** Starts the relay and waits until it is connected to Chrome. */
  async open(timeoutMs = 15_000): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.opened = { resolve, reject }
    })
    await this.channel.start(
      (line) => this.onLine(line),
      (reason) => this.onClose(reason),
    )
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CdpError('timed out connecting to Chrome')), timeoutMs)
        }),
      ])
    } catch (err) {
      await this.close()
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof msg.relay === 'string') {
      if (msg.relay === 'open') this.opened?.resolve()
      else if (msg.relay === 'error')
        this.opened?.reject(new CdpError(`Chrome is not reachable (${String(msg.message)})`))
      else if (msg.relay === 'list') {
        const waiter = this.relayPending.get(msg.id as number)
        if (!waiter) return
        this.relayPending.delete(msg.id as number)
        clearTimeout(waiter.timer)
        if (msg.error) waiter.reject(new CdpError(String(msg.error)))
        else waiter.resolve(msg.list)
      }
      return
    }
    if (typeof msg.id === 'number') {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      const error = msg.error as { message?: string; code?: number } | undefined
      if (error) waiter.reject(new CdpError(error.message ?? 'CDP error', error.code ?? null))
      else waiter.resolve(msg.result ?? {})
      return
    }
    if (typeof msg.method === 'string') {
      for (const listener of this.listeners)
        listener(msg.method, msg.params, msg.sessionId as string | undefined)
    }
  }

  private onClose(reason: string): void {
    if (this.closedReason) return
    this.closedReason = reason
    const err = new CdpError(`browser connection closed (${reason})`)
    this.opened?.reject(err)
    for (const map of [this.pending, this.relayPending]) {
      for (const waiter of map.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(err)
      }
      map.clear()
    }
  }

  on(listener: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 20_000,
  ): Promise<T> {
    if (this.closedReason)
      return Promise.reject(new CdpError(`browser connection closed (${this.closedReason})`))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.channel
        .send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        .catch((err) => {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err as Error)
        })
    })
  }

  /** Value of `expression` in the page; an exception thrown by the script rejects with its description. */
  async evaluate<T>(
    expression: string,
    sessionId: string,
    options: { awaitPromise?: boolean; userGesture?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const res = await this.send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        ...(options.userGesture ? { userGesture: true } : {}),
        ...(options.awaitPromise ? { awaitPromise: true } : {}),
      },
      sessionId,
      options.timeoutMs,
    )
    if (res.exceptionDetails)
      throw new CdpError(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'page script failed',
      )
    return res.result?.value as T
  }

  /** Tabs, most recently active first. */
  tabs(timeoutMs = 10_000): Promise<TabInfo[]> {
    if (this.closedReason)
      return Promise.reject(new CdpError(`browser connection closed (${this.closedReason})`))
    const id = ++this.nextId
    return new Promise<TabInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.relayPending.delete(id)
        reject(new CdpError('listing tabs timed out'))
      }, timeoutMs)
      this.relayPending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.channel.send(JSON.stringify({ relay: 'list', id })).catch((err) => {
        clearTimeout(timer)
        this.relayPending.delete(id)
        reject(err as Error)
      })
    })
  }

  async close(): Promise<void> {
    this.onClose('closed')
    await this.channel.close()
  }
}
