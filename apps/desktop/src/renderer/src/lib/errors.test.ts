import { ApiError } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { apiErrorReason, errorMessage, isApiError } from './errors'

describe('errors', () => {
  const conflict = new ApiError('conflict', 'VM_NOT_RUNNING', 409, { reason: 'last_bot' })

  it('reads the message of anything thrown', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('reads the reason of a daemon error', () => {
    expect(apiErrorReason(conflict)).toBe('last_bot')
    expect(apiErrorReason(new ApiError('conflict', 'x', 409, { reason: 3 }))).toBeUndefined()
    expect(apiErrorReason(new Error('x'))).toBeUndefined()
  })

  it('matches daemon errors by code', () => {
    expect(isApiError(conflict)).toBe(true)
    expect(isApiError(conflict, 'conflict')).toBe(true)
    expect(isApiError(conflict, 'not_found')).toBe(false)
    expect(isApiError(new Error('conflict'), 'conflict')).toBe(false)
  })
})
