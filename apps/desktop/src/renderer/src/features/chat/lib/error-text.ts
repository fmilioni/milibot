import { type CliEngine, type ErrorPayload, isCliEngine } from '@milibot/shared'
import type { TFunction } from 'i18next'

import { cliTextParams } from '@/lib/cli-engines'

/** The card's title: its code translated with its params (a CLI engine's by name), else the generic one. */
export function errorTitle(t: TFunction, payload: ErrorPayload): string {
  const engine = payload.params?.engine
  return String(
    t(`chat.error.codes.${payload.code}` as never, {
      ...payload.params,
      ...(isCliEngine(engine) ? cliTextParams(engine) : {}),
      defaultValue: t('chat.error.generic'),
    }),
  )
}

/**
 * Codes whose detail the app words itself, with the params each needs. The others (a provider's answer, a
 * crash) show the daemon's text as it came.
 */
const WORDED_DETAILS: Record<string, readonly string[]> = {
  no_provider: [],
  no_model: ['provider'],
  cli_unavailable: ['engine'],
}

/** The card's second line: translated for the codes above (cards saved without their params keep the text). */
export function errorDetail(t: TFunction, payload: ErrorPayload): string {
  const needs = WORDED_DETAILS[payload.code]
  const params = payload.params ?? {}
  const worded = needs?.every((name) => Object.hasOwn(params, name)) ?? false
  if (!worded) {
    return payload.detail
  }

  const engine = params.engine
  return String(
    t(`chat.error.details.${payload.code}` as never, {
      ...params,
      ...(isCliEngine(engine) ? cliTextParams(engine) : {}),
    }),
  )
}

/** The engine a card asks the user to log in to (its terminal opens from the card). */
export function loginEngineOf(payload: ErrorPayload): CliEngine | null {
  const engine = payload.params?.engine
  return payload.code === 'cli_login_required' && isCliEngine(engine) ? engine : null
}
