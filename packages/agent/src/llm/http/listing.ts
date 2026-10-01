const SHORT_DESCRIPTION = 160

/** A positive integer, also from a numeric string; null otherwise. */
export function positiveInt(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

/** A per-token price (OpenRouter's listing) as USD per million tokens; null when absent or invalid. */
export function perMillion(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1e6) / 1e6 : null
}

/** The first sentence, when it is short enough for a line under the name. */
export function shortDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const first =
    value
      .trim()
      .split(/(?<=[.!?])\s/)[0]
      ?.trim() ?? ''
  return first && first.length <= SHORT_DESCRIPTION ? first : null
}
