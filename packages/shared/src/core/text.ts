/** Lowercase text without accents ("Crème Brûlée" → "creme brulee"), for matching what people type. */
export function foldText(text: string, options: { trim?: boolean; normalize?: 'NFD' | 'NFKD' } = {}): string {
  const folded = text
    .normalize(options.normalize ?? 'NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  return options.trim ? folded.trim() : folded
}

export interface SlugifyOptions {
  /** Cut to this length, dropping a separator left at the end. */
  maxLength?: number
  /** Returned when nothing is left. */
  fallback?: string
  /** `NFKD` also turns compatibility characters into ASCII ("ﬁ" → "fi", "²" → "2"). */
  normalize?: 'NFD' | 'NFKD'
}

/** Lowercase ASCII slug: runs of anything but `[a-z0-9]` become one `-` ("New Store!" → "new-store"). */
export function slugify(text: string, options: SlugifyOptions = {}): string {
  let slug = foldText(text, { normalize: options.normalize })
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (options.maxLength !== undefined) slug = slug.slice(0, options.maxLength).replace(/-+$/, '')
  return slug || (options.fallback ?? '')
}

export interface ClipOptions {
  /** `flatten` collapses every whitespace run into one space and trims; `trim` only trims. */
  whitespace?: 'flatten' | 'trim' | 'keep'
  /** true: the result, ellipsis included, is at most `max` long; false: `max` characters plus the ellipsis. */
  withinMax?: boolean
}

/** Text cut with an ellipsis when over `max` characters (a single line by default). */
export function clipLine(text: string, max: number, options: ClipOptions = {}): string {
  const whitespace = options.whitespace ?? 'flatten'
  const value =
    whitespace === 'flatten' ? text.replace(/\s+/g, ' ').trim() : whitespace === 'trim' ? text.trim() : text
  if (value.length <= max) return value
  return `${value.slice(0, options.withinMax === false ? max : max - 1)}…`
}

/**
 * No provider tokenizer is cheap enough to call per message, so token estimates are chars/3.5: close for
 * English and slightly pessimistic for Portuguese and code, which is the safe side for budgets.
 */
export const CHARS_PER_TOKEN = 3.5

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Largest role section (`# Your role`) a bot's persona may have, in estimated tokens. */
export const PERSONA_MAX_TOKENS = 1_500
