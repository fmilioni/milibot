import type { ErrorPayload } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import { errorDetail } from './error-text'

const t = ((key: string, options?: Record<string, unknown>) =>
  `${key} ${JSON.stringify(options)}`) as unknown as TFunction

const card = (patch: Partial<ErrorPayload>): ErrorPayload => ({
  type: 'error',
  code: 'no_model',
  detail: 'Choose a model for the provider "Local" (or for this bot).',
  ...patch,
})

describe('errorDetail', () => {
  it('words a setup error with its params', () => {
    expect(errorDetail(t, card({ params: { provider: 'Local' } }))).toBe(
      'chat.error.details.no_model {"provider":"Local"}',
    )
    expect(errorDetail(t, card({ code: 'no_provider', detail: 'No provider' }))).toBe(
      'chat.error.details.no_provider {}',
    )
  })

  it("keeps the daemon's text for a card saved without the params, or a provider's answer", () => {
    expect(errorDetail(t, card({}))).toBe('Choose a model for the provider "Local" (or for this bot).')
    expect(errorDetail(t, card({ code: 'provider_error', detail: 'HTTP 401: invalid key' }))).toBe(
      'HTTP 401: invalid key',
    )
  })
})
