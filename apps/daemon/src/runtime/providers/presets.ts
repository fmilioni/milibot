import { OPENROUTER_BASE_URL } from '@milibot/shared'

const GOOGLE_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'

export function presetBaseUrl(preset: string | null | undefined): string | null {
  if (preset === 'openrouter') return OPENROUTER_BASE_URL
  if (preset === 'google') return GOOGLE_OPENAI_BASE_URL
  return null
}
