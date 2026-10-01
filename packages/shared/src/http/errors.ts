import { z } from 'zod'

export const ApiErrorCode = z.enum([
  'unauthorized',
  'not_found',
  'validation_failed',
  'conflict',
  'runtime_unavailable',
  /** The target (e.g. a CLI engine) lacks the capability the route asks for. */
  'unsupported',
  'internal',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCode>

export const ApiErrorBody = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ApiErrorBody = z.infer<typeof ApiErrorBody>

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  runtime_unavailable: 503,
  unsupported: 400,
  internal: 500,
}

export class ApiError extends Error {
  readonly code: ApiErrorCode | 'network'
  readonly status: number
  readonly details?: unknown

  constructor(code: ApiErrorCode | 'network', message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}
