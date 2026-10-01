import type { GuestCliBackend } from './backend'

/** Time a process gets to exit after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 5_000
/** Time a turn gets to end after it was interrupted before its process is killed. */
const INTERRUPT_GRACE_MS = 10_000

export interface CliTiming {
  interruptGraceMs: number
  killGraceMs: number
}

export const DEFAULT_CLI_TIMING: CliTiming = {
  interruptGraceMs: INTERRUPT_GRACE_MS,
  killGraceMs: KILL_GRACE_MS,
}

/**
 * Joins the stdout pieces of a line the guest split: a line longer than its limit arrives as several events,
 * all but the last flagged `partial`.
 */
export class LineAssembler {
  private pending = ''

  /** The whole line once its last piece arrived, else null. */
  push(data: string, partial: boolean | undefined): string | null {
    this.pending += data
    if (partial) return null
    const line = this.pending
    this.pending = ''
    return line
  }

  /** What is left when the process exits (the guest flags a last line without a newline as partial). */
  flush(): string | null {
    const line = this.pending
    this.pending = ''
    return line || null
  }
}

/** A promise settled by `resolve`, for "the process exited". */
export function exitSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * Ends a CLI process: EOF on stdin and SIGTERM (SIGKILL at once with `force`). Unless `exited` settles within
 * `graceMs`, SIGKILL follows in the background (the guest refuses signals to a process that already exited);
 * `onSettled` runs once the process exited or was killed.
 */
export async function stopCliProcess(
  backend: GuestCliBackend,
  procId: string,
  options: { exited: Promise<void>; graceMs?: number; force?: boolean; onSettled?: () => void },
): Promise<void> {
  await backend.writeStdin(procId, '', true).catch(() => undefined)
  await backend.signal(procId, options.force ? 'SIGKILL' : 'SIGTERM').catch(() => undefined)
  if (options.force) {
    options.onSettled?.()
    return
  }
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), options.graceMs ?? KILL_GRACE_MS)
    timer.unref?.()
  })
  void Promise.race([options.exited.then(() => false), timeout]).then(async (late) => {
    if (timer) clearTimeout(timer)
    if (late) await backend.signal(procId, 'SIGKILL').catch(() => undefined)
    options.onSettled?.()
  })
}

/**
 * Stops a running turn when `signal` aborts (or already has): `interrupt` asks the engine, and `deadline` aborts
 * if the turn has not ended `graceMs` later (the process is then killed, not asked again).
 */
export class TurnInterrupt {
  interrupted = false
  private timer: NodeJS.Timeout | null = null
  private readonly expired = new AbortController()
  readonly deadline = this.expired.signal

  private readonly onAbort = () => {
    this.interrupted = true
    this.interrupt()
    this.timer ??= setTimeout(() => this.expired.abort(new Error('interrupt timeout')), this.graceMs)
  }

  constructor(
    private readonly signal: AbortSignal,
    private readonly interrupt: () => void,
    private readonly graceMs: number,
  ) {
    // A stop that arrived while the process was starting still interrupts the turn.
    if (signal.aborted) this.onAbort()
    else signal.addEventListener('abort', this.onAbort, { once: true })
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.signal.removeEventListener('abort', this.onAbort)
  }
}
