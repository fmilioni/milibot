import { api } from '@milibot/shared'

export interface ShutdownTarget {
  pid: number
  baseUrl: string
  token: string
}

export interface ShutdownDeps {
  fetch: typeof fetch
  isAlive(pid: number): boolean
  /** Sends a signal; throws when the process is gone (like `process.kill`). */
  kill(pid: number, signal: NodeJS.Signals): void
  sleep(ms: number): Promise<void>
  now(): number
  platform: NodeJS.Platform
}

type ShutdownMethod = 'route' | 'signal' | 'none'

export interface ShutdownResult {
  stopped: boolean
  /** How the stop was requested (`none`: the daemon was not running). */
  method: ShutdownMethod
}

const REQUEST_TIMEOUT_MS = 5_000
const POLL_MS = 250

/**
 * Stops the daemon so it applies each workspace's close behavior (suspending a VM takes a while).
 * First `POST /shutdown` (works everywhere, and it is the only graceful way on Windows, where a
 * signal kills the process without running its handlers). When the route fails, macOS and Linux fall
 * back to SIGTERM; Windows has no graceful fallback, so the process is left running and the call
 * reports failure.
 */
export async function shutdownDaemon(
  target: ShutdownTarget,
  deps: ShutdownDeps,
  timeoutMs: number,
): Promise<ShutdownResult> {
  if (!deps.isAlive(target.pid)) return { stopped: true, method: 'none' }

  let method: ShutdownMethod = 'route'
  let accepted: boolean
  try {
    const res = await deps.fetch(target.baseUrl + api.shutdown.path, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    accepted = res.ok
  } catch {
    accepted = false
  }

  if (!accepted) {
    if (deps.platform === 'win32') return { stopped: !deps.isAlive(target.pid), method }
    method = 'signal'
    try {
      deps.kill(target.pid, 'SIGTERM')
    } catch {
      return { stopped: true, method }
    }
  }

  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline) {
    if (!deps.isAlive(target.pid)) return { stopped: true, method }
    await deps.sleep(POLL_MS)
  }
  return { stopped: !deps.isAlive(target.pid), method }
}
