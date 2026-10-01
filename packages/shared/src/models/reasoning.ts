import { z } from 'zod'

/** Levels Milibot knows and ranks, lowest first; each provider maps them to its own parameter. */
export const StandardEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type StandardEffort = z.infer<typeof StandardEffort>
export const REASONING_EFFORTS = StandardEffort.options

/**
 * How much a model reasons before answering: a standard level, or a server's own value registered on the
 * model (`provider_models.efforts`), sent as is and never ranked.
 */
export const ReasoningEffort = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/)
export type ReasoningEffort = string

export function isStandardEffort(level: string): level is StandardEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(level)
}

/** A typed level as stored: standard levels lowercased, custom ones as written; null when invalid. */
export function normalizeEffort(input: string): ReasoningEffort | null {
  const value = input.trim()
  const lower = value.toLowerCase()
  if (isStandardEffort(lower)) return lower
  return ReasoningEffort.safeParse(value).success ? value : null
}

export const MIN_CONTEXT_LIMIT = 16_000

/** Tuning of one model choice (bot, default model, work session); null/absent = the model's own default. */
export const ModelTuning = z.object({
  effort: ReasoningEffort.nullable().optional(),
  /** Context the lane may fill, below the model's window (a 1M model used as 256k costs less per turn). */
  contextLimit: z.number().int().min(MIN_CONTEXT_LIMIT).nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
})
export type ModelTuning = z.infer<typeof ModelTuning>

/** A provider + model pair and its tuning; `model: null` = the provider's default model. */
export const ModelChoice = z
  .object({ providerId: z.string(), model: z.string().nullable() })
  .extend(ModelTuning.shape)
export type ModelChoice = z.infer<typeof ModelChoice>

/**
 * The effort to send for `requested` given the levels a model accepts: itself when accepted (a custom level
 * matches regardless of case, in the model's spelling), else for a standard level the nearest accepted
 * standard level (the higher one on a tie); null when nothing fits (the model runs at its own default).
 * `supported` null = unknown, the request goes as asked.
 */
export function pickEffort(
  requested: ReasoningEffort | null | undefined,
  supported: readonly ReasoningEffort[] | null | undefined,
): ReasoningEffort | null {
  if (!requested) return null
  if (!supported) return requested
  const exact = supported.find((level) => level.toLowerCase() === requested.toLowerCase())
  if (exact) return exact
  if (!isStandardEffort(requested)) return null
  const rank = REASONING_EFFORTS.indexOf(requested)
  let best: StandardEffort | null = null
  let bestDistance = Infinity
  for (const level of supported) {
    if (!isStandardEffort(level)) continue
    const distance = Math.abs(REASONING_EFFORTS.indexOf(level) - rank)
    if (distance < bestDistance || (distance === bestDistance && level !== best && isHigher(level, best))) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

function isHigher(a: StandardEffort, b: StandardEffort | null): boolean {
  return b === null || REASONING_EFFORTS.indexOf(a) > REASONING_EFFORTS.indexOf(b)
}
