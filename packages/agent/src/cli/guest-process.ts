import type { GuestCliBackend, GuestProcSpec } from './backend'
import type { CliLog } from './engine'
import { exitSignal, KILL_GRACE_MS, LineAssembler, stopCliProcess } from './process'

/** The process (or the VM) is gone after this many failed reconnects of its event stream. */
const MAX_STREAM_FAILURES = 5
const STDERR_TAIL = 4000

export interface GuestProcessExit {
  code: number | null
  signal: string | null
  /** Tail of its stderr, or why its event stream was lost. */
  stderr: string
}

export interface GuestProcessHandlers {
  /** One whole stdout line (pieces the guest split are joined). */
  line(text: string): void
  /** The process exited by itself (never called after `close`). */
  exit(exit: GuestProcessExit): void
}

/**
 * A CLI process in the VM: its stdout read line by line (reconnecting to the event stream when it drops), and
 * stopped with EOF + SIGTERM, escalating to SIGKILL (`stopCliProcess`).
 */
export class GuestProcess {
  /** False once the process exited or was closed. */
  alive = true
  private closed = false
  private readonly pump = new AbortController()
  private readonly exit = exitSignal()
  private stderr = ''

  private constructor(
    private readonly backend: GuestCliBackend,
    readonly id: string,
    readonly label: string,
    private readonly log: CliLog,
    private readonly killGraceMs: number,
  ) {}

  /** Starts the process; nothing is read until `listen`. */
  static async start(
    backend: GuestCliBackend,
    spec: GuestProcSpec,
    options: { log?: CliLog; killGraceMs?: number } = {},
  ): Promise<GuestProcess> {
    const { id } = await backend.startProcess(spec)
    return new GuestProcess(
      backend,
      id,
      spec.label,
      options.log ?? (() => {}),
      options.killGraceMs ?? KILL_GRACE_MS,
    )
  }

  listen(handlers: GuestProcessHandlers): void {
    void this.read(handlers)
  }

  write(data: string, eof = false): Promise<void> {
    return this.backend.writeStdin(this.id, data, eof)
  }

  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void> {
    return this.backend.signal(this.id, signal)
  }

  /** `force`: SIGKILL at once (the process already ignored a stop). */
  async close(force = false): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.alive) {
      this.pump.abort()
      return
    }
    this.alive = false
    await stopCliProcess(this.backend, this.id, {
      exited: this.exit.promise,
      graceMs: this.killGraceMs,
      force,
      onSettled: () => this.pump.abort(),
    })
  }

  private ended(handlers: GuestProcessHandlers, exit: GuestProcessExit): void {
    this.exit.resolve()
    if (this.closed) return
    this.alive = false
    handlers.exit(exit)
  }

  private async read(handlers: GuestProcessHandlers): Promise<void> {
    let since = 0
    let failures = 0
    const lines = new LineAssembler()
    const emit = (line: string | null) => {
      if (line !== null) handlers.line(line)
    }
    while (!this.pump.signal.aborted) {
      try {
        for await (const event of this.backend.events(this.id, since, this.pump.signal)) {
          if ('seq' in event) since = event.seq
          failures = 0
          if (event.type === 'stdout') {
            emit(lines.push(event.data, event.partial))
          } else if (event.type === 'stderr') {
            this.stderr = (this.stderr + event.data + '\n').slice(-STDERR_TAIL)
          } else if (event.type === 'exit') {
            emit(lines.flush())
            return this.ended(handlers, { code: event.code, signal: event.signal, stderr: this.stderr })
          } else if (event.type === 'error') {
            emit(lines.flush())
            return this.ended(handlers, { code: null, signal: null, stderr: event.message })
          }
        }
      } catch (err) {
        if (this.pump.signal.aborted) return
        if (++failures >= MAX_STREAM_FAILURES)
          return this.ended(handlers, { code: null, signal: null, stderr: (err as Error).message })
        this.log('cli event stream failed; reconnecting', { label: this.label, err: (err as Error).message })
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
}

/** "<name> exited (code N, SIGNAL): <stderr tail>". */
export function exitMessage(name: string, exit: GuestProcessExit): string {
  const stderr = exit.stderr.trim().slice(-1500)
  return `${name} exited (code ${exit.code ?? 'null'}${exit.signal ? `, ${exit.signal}` : ''})${stderr ? `: ${stderr}` : ''}`
}
