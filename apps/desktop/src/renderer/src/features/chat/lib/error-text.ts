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

/** The engine a card asks the user to log in to (its terminal opens from the card). */
export function loginEngineOf(payload: ErrorPayload): CliEngine | null {
  const engine = payload.params?.engine
  return payload.code === 'cli_login_required' && isCliEngine(engine) ? engine : null
}
