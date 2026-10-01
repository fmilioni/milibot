import type { ApiErrorBody, ApiErrorCode } from '@milibot/shared'

export class DaemonError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}

export function notFound(what: string, id: string): DaemonError {
  return new DaemonError('not_found', `${what} not found: ${id}`)
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The API error body of anything a handler threw: a `DaemonError` as it is, a client error of the HTTP layer
 * (status below 500) as `validation_failed`, anything else as `internal` (`unexpected`: log it).
 */
export function toApiError(err: unknown): { error: ApiErrorBody['error']; unexpected: boolean } {
  if (err instanceof DaemonError)
    return { error: { code: err.code, message: err.message, details: err.details }, unexpected: false }
  if (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof err.statusCode === 'number' &&
    err.statusCode < 500
  ) {
    const message = err instanceof Error ? err.message : 'Bad request'
    return { error: { code: 'validation_failed', message }, unexpected: false }
  }
  return {
    error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
    unexpected: true,
  }
}
