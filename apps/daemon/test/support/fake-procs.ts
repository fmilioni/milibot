import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export interface FakeGuestProc {
  id: string
  label: string
  argv: string[]
  env: Record<string, string>
  child: ChildProcessWithoutNullStreams
  events: Array<Record<string, unknown> & { seq: number }>
  running: boolean
  listeners: Set<() => void>
}

/** Runs `/procs` requests as real local processes (argv as is, `user` ignored). */
export function startFakeProc(
  procs: Map<string, FakeGuestProc>,
  body: Record<string, unknown>,
): FakeGuestProc {
  const argv = body.argv as string[]
  const env = (body.env as Record<string, string> | undefined) ?? {}
  const child = spawn(argv[0] as string, argv.slice(1), {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const proc: FakeGuestProc = {
    id: `proc-${procs.size + 1}`,
    label: String(body.label ?? ''),
    argv,
    env,
    child,
    events: [],
    running: true,
    listeners: new Set(),
  }
  let seq = 0
  const push = (event: Record<string, unknown>) => {
    proc.events.push({ ...event, seq: ++seq })
    for (const listener of proc.listeners) listener()
  }
  const lines = (type: 'stdout' | 'stderr') => {
    let pending = ''
    return (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let index: number
      while ((index = pending.indexOf('\n')) !== -1) {
        push({ type, data: pending.slice(0, index) })
        pending = pending.slice(index + 1)
      }
    }
  }
  child.stdout.on('data', lines('stdout'))
  child.stderr.on('data', lines('stderr'))
  child.stdin.on('error', () => undefined)
  child.on('close', (code, signal) => {
    proc.running = false
    push({ type: 'exit', code, signal })
  })
  procs.set(proc.id, proc)
  return proc
}

/** `/procs/:id/events`: NDJSON after `since`, ending with the exit event. */
export function procEventsResponse(
  proc: FakeGuestProc,
  since: number,
  signal?: AbortSignal | null,
): Response {
  const encoder = new TextEncoder()
  let last = since
  let cleanup = () => undefined as void
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const flush = () => {
        for (const event of proc.events) {
          if (event.seq <= last) continue
          last = event.seq
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          if (event.type === 'exit') {
            cleanup()
            controller.close()
            return
          }
        }
      }
      cleanup = () => {
        proc.listeners.delete(flush)
      }
      proc.listeners.add(flush)
      signal?.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
      flush()
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
}
