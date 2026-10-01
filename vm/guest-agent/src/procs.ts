import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { GuestProcEvent, GuestProcRecord as ProcEvent } from '@milibot/shared/portable/guest-api'

import { badRequest, conflict, notFound } from './errors.ts'
import { killGroup } from './spawn.ts'
import type { SpawnSpec } from './users.ts'

type ProcEventBody = ProcEvent extends infer E ? (E extends ProcEvent ? Omit<E, 'seq' | 't'> : never) : never

export interface ProcInfo {
  id: string
  pid: number | undefined
  user: string
  label?: string
  startedAt: number
  exitedAt?: number
  running: boolean
  exit?: { code: number | null; signal: string | null }
  firstSeq: number
  lastSeq: number
}

const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
const RETAIN_EXITED_MS = 15 * 60 * 1000
const HEARTBEAT_MS = 15_000
const ALLOWED_SIGNALS = new Set([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGHUP',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
  'SIGSTOP',
  'SIGCONT',
])

export class LineSplitter {
  private pending = ''
  private decoder = new TextDecoder()

  constructor(private readonly emit: (line: string, partial: boolean) => void) {}

  push(chunk: Buffer): void {
    this.pending += this.decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = this.pending.indexOf('\n')) !== -1) {
      this.emit(this.pending.slice(0, idx), false)
      this.pending = this.pending.slice(idx + 1)
    }
    if (this.pending.length > MAX_LINE_BYTES) {
      this.emit(this.pending, true)
      this.pending = ''
    }
  }

  flush(): void {
    this.pending += this.decoder.decode()
    if (this.pending.length > 0) this.emit(this.pending, true)
    this.pending = ''
  }
}

class ManagedProc extends EventEmitter {
  readonly id = randomUUID()
  readonly startedAt = Date.now()
  exitedAt?: number
  exit?: { code: number | null; signal: string | null }
  private events: ProcEvent[] = []
  private bufferedBytes = 0
  private seq = 0

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly user: string,
    readonly label: string | undefined,
  ) {
    super()
    this.setMaxListeners(0)
  }

  get running(): boolean {
    return this.exit === undefined
  }

  push(body: ProcEventBody): void {
    const event = { ...body, seq: ++this.seq, t: Date.now() } as ProcEvent
    this.events.push(event)
    this.bufferedBytes += 'data' in event ? event.data.length : 64
    while (this.bufferedBytes > MAX_BUFFERED_BYTES && this.events.length > 1) {
      const dropped = this.events.shift()!
      this.bufferedBytes -= 'data' in dropped ? dropped.data.length : 64
    }
    this.emit('event', event)
  }

  since(seq: number): ProcEvent[] {
    return this.events.filter((e) => e.seq > seq)
  }

  info(): ProcInfo {
    return {
      id: this.id,
      pid: this.child.pid,
      user: this.user,
      ...(this.label ? { label: this.label } : {}),
      startedAt: this.startedAt,
      ...(this.exitedAt ? { exitedAt: this.exitedAt } : {}),
      running: this.running,
      ...(this.exit ? { exit: this.exit } : {}),
      firstSeq: this.events[0]?.seq ?? this.seq + 1,
      lastSeq: this.seq,
    }
  }
}

export class ProcessManager {
  private procs = new Map<string, ManagedProc>()

  constructor() {
    setInterval(() => this.gc(), 60_000).unref()
  }

  start(spec: SpawnSpec, opts: { cwd: string; user: string; label?: string }): ProcInfo {
    const child = spawn(spec.file, spec.args, {
      cwd: opts.cwd,
      env: spec.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const proc = new ManagedProc(child, opts.user, opts.label)
    const out = new LineSplitter((data, partial) =>
      proc.push({ type: 'stdout', data, ...(partial ? { partial } : {}) }),
    )
    const err = new LineSplitter((data, partial) =>
      proc.push({ type: 'stderr', data, ...(partial ? { partial } : {}) }),
    )
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.stdin.on('error', () => {})
    child.on('error', (e) => {
      proc.push({ type: 'error', message: e.message })
      if (!proc.exit) {
        proc.exit = { code: null, signal: null }
        proc.exitedAt = Date.now()
        proc.push({ type: 'exit', code: null, signal: null })
      }
    })
    child.on('close', (code, signal) => {
      out.flush()
      err.flush()
      if (proc.exit) return
      proc.exit = { code, signal }
      proc.exitedAt = Date.now()
      proc.push({ type: 'exit', code, signal })
    })
    this.procs.set(proc.id, proc)
    return proc.info()
  }

  get(id: string): ManagedProc {
    const proc = this.procs.get(id)
    if (!proc) throw notFound(`process not found: ${id}`, 'unknown_process')
    return proc
  }

  list(): ProcInfo[] {
    return [...this.procs.values()].map((p) => p.info())
  }

  write(id: string, data: string, eof: boolean): void {
    const proc = this.get(id)
    if (!proc.running) throw conflict('process has exited', 'process_exited')
    if (data) proc.child.stdin.write(data)
    if (eof) proc.child.stdin.end()
  }

  signal(id: string, signal: unknown): void {
    const sig = typeof signal === 'string' ? signal.toUpperCase() : 'SIGTERM'
    if (!ALLOWED_SIGNALS.has(sig)) throw badRequest(`signal not allowed: ${String(signal)}`, 'invalid_signal')
    const proc = this.get(id)
    if (!proc.running || !proc.child.pid) throw conflict('process has exited', 'process_exited')
    if (!killGroup(proc.child, sig as NodeJS.Signals)) proc.child.kill(sig as NodeJS.Signals)
  }

  /** `GET /procs/:id/events`: NDJSON of the buffered events after `since`, then live ones until the exit. */
  streamEvents(req: IncomingMessage, res: ServerResponse, id: string, since: number): void {
    const proc = this.get(id)
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    const write = (e: GuestProcEvent) => res.write(JSON.stringify(e) + '\n')
    let last = since
    for (const e of proc.since(since)) {
      write(e)
      last = e.seq
    }
    if (!proc.running) {
      res.end()
      return
    }
    const onEvent = (e: ProcEvent) => {
      if (e.seq <= last) return
      last = e.seq
      write(e)
      if (e.type === 'exit') cleanup(true)
    }
    const heartbeat = setInterval(() => write({ type: 'heartbeat' }), HEARTBEAT_MS)
    const cleanup = (end: boolean) => {
      clearInterval(heartbeat)
      proc.off('event', onEvent)
      if (end) res.end()
    }
    proc.on('event', onEvent)
    req.on('close', () => cleanup(false))
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, proc] of this.procs) {
      if (proc.exitedAt && now - proc.exitedAt > RETAIN_EXITED_MS) this.procs.delete(id)
    }
  }
}
