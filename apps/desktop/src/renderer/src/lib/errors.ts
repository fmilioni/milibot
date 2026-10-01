import { ApiError, type ApiErrorCode } from '@milibot/shared'

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `details.reason` of a daemon error (`last_bot`, `not_a_backup`, …). */
export function apiErrorReason(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined
  const reason = (err.details as { reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' ? reason : undefined
}

/** A daemon error, optionally with this code. */
export function isApiError(err: unknown, code?: ApiErrorCode | 'network'): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code)
}
