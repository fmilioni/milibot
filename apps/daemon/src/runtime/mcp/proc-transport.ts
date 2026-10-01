import type { GuestProcEvent } from '@milibot/agent/cli'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'

/** Process API of the guest agent (`/procs`), as the daemon exposes it. */
export interface GuestProcBackend {
  startProcess(spec: {
    user: string
    argv: string[]
    cwd: string
    env: Record<string, string>
    label: string
  }): Promise<{ id: string }>
  events(procId: string, since: number, signal: AbortSignal): AsyncIterable<GuestProcEvent>
  writeStdin(procId: string, data: string, eof?: boolean): Promise<void>
  signal(procId: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>
}

export interface GuestProcTransportOptions {
  argv: string[]
  env: Record<string, string>
  label: string
  user?: string
  cwd?: string
  /** Event stream reconnects before the process is considered gone. */
  maxStreamFailures?: number
  retryDelayMs?: number
}

const STDERR_TAIL = 4000

/**
 * MCP stdio transport for a server running inside the VM: the process is started through the guest
 * agent, requests go to its stdin (one JSON-RPC message per line) and its stdout lines come back as
 * NDJSON events. A broken event stream is resumed from the last sequence number.
 */
export class GuestProcTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  private procId: string | null = null
  private readonly pump = new AbortController()
  private closed = false
  private writes: Promise<void> = Promise.resolve()
  private stderr = ''

  constructor(
    private readonly backend: GuestProcBackend,
    private readonly options: GuestProcTransportOptions,
  ) {}

  /** Last lines the server wrote to stderr (startup errors: missing package, bad credentials…). */
  get stderrTail(): string {
    return this.stderr.trim()
  }

  get processId(): string | null {
    return this.procId
  }

  async start(): Promise<void> {
    if (this.procId) throw new Error('GuestProcTransport already started')
    const { id } = await this.backend.startProcess({
      user: this.options.user ?? 'agent',
      argv: this.options.argv,
      cwd: this.options.cwd ?? '/workspace',
      env: this.options.env,
      label: this.options.label,
    })
    this.procId = id
    void this.readEvents(id)
  }

  private async readEvents(id: string): Promise<void> {
    const maxFailures = this.options.maxStreamFailures ?? 5
    const delay = this.options.retryDelayMs ?? 1000
    let since = 0
    let failures = 0
    while (!this.closed) {
      try {
        for await (const event of this.backend.events(id, since, this.pump.signal)) {
          if ('seq' in event) since = event.seq
          failures = 0
          if (event.type === 'stdout') this.handleLine(event.data)
          else if (event.type === 'stderr')
            this.stderr = (this.stderr + event.data + '\n').slice(-STDERR_TAIL)
          else if (event.type === 'error') this.onerror?.(new Error(event.message))
          else if (event.type === 'exit') {
            const reason = event.signal ? `signal ${event.signal}` : `code ${event.code ?? 'null'}`
            if (!this.closed) this.onerror?.(new Error(this.exitMessage(reason)))
            this.finish()
            return
          }
        }
        if (this.closed) return
        failures++
      } catch (err) {
        if (this.closed) return
        failures++
        if (failures >= maxFailures) {
          this.onerror?.(new Error(`lost the server process: ${(err as Error).message}`))
          this.finish()
          return
        }
      }
      if (failures >= maxFailures) {
        this.onerror?.(new Error('lost the server process'))
        this.finish()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  private exitMessage(reason: string): string {
    const tail = this.stderrTail
    return `server process exited (${reason})${tail ? `: ${tail.split('\n').slice(-5).join('\n')}` : ''}`
  }

  private handleLine(line: string): void {
    const text = line.trim()
    if (!text) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Servers sometimes log to stdout; that is not protocol traffic.
      return
    }
    const message = JSONRPCMessageSchema.safeParse(parsed)
    if (!message.success) {
      this.onerror?.(new Error(`invalid JSON-RPC message from server: ${text.slice(0, 200)}`))
      return
    }
    this.onmessage?.(message.data)
  }

  send(message: JSONRPCMessage): Promise<void> {
    const id = this.procId
    if (!id || this.closed) return Promise.reject(new Error('transport is not connected'))
    const write = this.writes.then(() => this.backend.writeStdin(id, `${JSON.stringify(message)}\n`))
    this.writes = write.catch(() => undefined)
    return write
  }

  async close(): Promise<void> {
    if (this.closed) return
    const id = this.procId
    this.closed = true
    this.pump.abort()
    if (id) {
      await this.backend.writeStdin(id, '', true).catch(() => undefined)
      await this.backend.signal(id, 'SIGTERM').catch(() => undefined)
    }
    this.onclose?.()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.pump.abort()
    this.onclose?.()
  }
}
