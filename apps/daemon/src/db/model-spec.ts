import { ModelChoice } from '@milibot/shared'

import { parseJson } from './sqlite'

/** A `model_spec` column (work sessions, plans): the model chosen for that work, null = the bot's own. */
export function parseModelSpec(json: string | null): ModelChoice | null {
  if (!json) return null
  const parsed = ModelChoice.safeParse(parseJson<unknown>(json, null))
  return parsed.success ? parsed.data : null
}

export function modelSpecJson(choice: ModelChoice | null | undefined): string | null {
  return choice ? JSON.stringify(choice) : null
}
