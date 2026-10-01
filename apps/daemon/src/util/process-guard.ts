import type { EventEmitter } from 'node:events'

const TRANSIENT_CODES = new Set(['ECONNRESET', 'EPIPE'])

function transient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const { code, syscall } = err as { code?: unknown; syscall?: unknown }
  return syscall === 'setTypeOfService' || (typeof code === 'string' && TRANSIENT_CODES.has(code))
}

/** Socket failures that escape a request (e.g. undici's setTypeOfService EINVAL on a reset connection). */
export function isTransientNetworkError(err: unknown): boolean {
  return transient(err) || (err instanceof Error && transient(err.cause))
}

type Log = (level: 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void

/**
 * A transient network error that escaped its request only affects that request (which fails or is retried),
 * so it must not take down the runtime and the bots' desktops with it. Anything else still exits like Node's
 * default handlers do.
 */
export function installProcessGuard(
  log: Log,
  exit: (code: number) => void = (code) => process.exit(code),
  target: EventEmitter = process,
): void {
  const handle = (kind: 'uncaughtException' | 'unhandledRejection') => (err: unknown) => {
    if (isTransientNetworkError(err)) {
      const { code, syscall } = err as { code?: unknown; syscall?: unknown }
      log('warn', `${kind} ignored (transient network error)`, {
        err: (err as Error).message,
        code,
        syscall,
      })
      return
    }
    log('error', kind, { err: err instanceof Error ? (err.stack ?? err.message) : String(err) })
    exit(1)
  }
  target.on('uncaughtException', handle('uncaughtException'))
  target.on('unhandledRejection', handle('unhandledRejection'))
}
