import { REASONING_EFFORTS } from '@milibot/shared'

export const EFFORT_ARG_HINT = `${REASONING_EFFORTS.join(', ')}, or another level list_models shows for the model.`

/**
 * Model of a piece of work, only when the user asked for one (kept terse: the plans-and-sessions skill
 * explains them).
 */
export const MODEL_REQUEST_ARGS = {
  model: { type: 'string', description: 'Only when the user asked for it.' },
  effort: { type: 'string', description: 'Only when the user asked for it.' },
  context: { type: 'string' },
  provider: { type: 'string' },
} as const
