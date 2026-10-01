import type { ChildProcess } from 'node:child_process'

/** Signals the child's process group (children spawned with `detached: true`); false when it is gone. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    if (!child.pid) return false
    process.kill(-child.pid, signal)
    return true
  } catch {
    return false
  }
}

/** After `ms`: `onTimeout`, SIGTERM to the group, SIGKILL 3 s later. Returns the cancel function. */
export function armTimeout(
  child: ChildProcess,
  ms: number,
  onTimeout: () => void = () => undefined,
): () => void {
  const timer = setTimeout(() => {
    onTimeout()
    killGroup(child, 'SIGTERM')
    setTimeout(() => killGroup(child, 'SIGKILL'), 3000).unref()
  }, ms)
  return () => clearTimeout(timer)
}

/** The last `max` characters of a stream's output (error messages quote it). */
export class OutputTail {
  text = ''

  constructor(private readonly max: number) {}

  readonly push = (chunk: Buffer | string): void => {
    this.text = (this.text + chunk.toString()).slice(-this.max)
  }
}
