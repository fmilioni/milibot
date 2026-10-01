import { foldText } from '@milibot/shared'

const STOPWORDS = new Set(
  // Portuguese on purpose: pt-BR stopwords, users write in Portuguese
  (
    'que para com uma um uns umas dos das nos nas pelo pela pelos pelas por como mas mais menos isso isto ' +
    'esse essa esses essas este esta estes estas aquele aquela aquilo ele ela eles elas voce voces meu minha ' +
    'meus minhas seu sua seus suas nosso nossa dele dela tem ter tinha foi ser sao era estou esta estao ' +
    'vou vai sim nao qual quais quando onde quem porque pois entao tambem ainda sobre entre ate depois antes ' +
    'aqui ali muito muita pode podia faz fazer fiz lembra lembrar lembrou disse falei falou sabe saber qualquer ' +
    'tudo nada algum alguma coisa ' +
    // en
    'the and for are but not you your yours with this that these those have has had was were will would ' +
    'can could should what which when where who whom why how about from into than then them they their ' +
    "there here our ours his her hers its it's did does doing just also any some all remember tell said know"
  ).split(/\s+/),
)

/**
 * Keyword terms of a free-text query for full-text search: lowercased, without diacritics and
 * stopwords, numbers kept. Longest terms first (they tend to be the most specific), deduplicated.
 */
export function searchTerms(text: string, max = 12): string[] {
  const words = foldText(text).match(/[\p{L}\p{N}][\p{L}\p{N}._-]*[\p{L}\p{N}]|\p{N}/gu) ?? []
  const terms = new Set<string>()
  for (const raw of words) {
    for (const word of raw.split(/[._-]+/).concat(raw.includes('.') ? [raw] : [])) {
      if (!word) continue
      const numeric = /^\p{N}+$/u.test(word)
      if (word.length < (numeric ? 2 : 3)) continue
      if (STOPWORDS.has(word)) continue
      terms.add(word)
    }
  }
  return [...terms].sort((a, b) => b.length - a.length).slice(0, max)
}

/**
 * Prefix used to match inflections of a word term (plural, gender, verb endings): the last two
 * characters of long words are dropped. Short words, numbers and dotted/hyphenated ids match whole.
 */
export function termPrefix(term: string): string | null {
  if (term.length < 5 || /[._-]/.test(term) || /^\p{N}+$/u.test(term)) return null
  return term.length >= 6 ? term.slice(0, Math.max(5, term.length - 2)) : term
}

/** FTS5 MATCH expression: any of the terms, prefix-matched when long enough. */
export function ftsMatchExpression(terms: string[]): string | null {
  const parts = terms
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => {
      const prefix = termPrefix(t)
      return prefix ? `"${prefix}"*` : `"${t}"`
    })
  return parts.length ? parts.join(' OR ') : null
}

/** A window of `content` around the first term occurrence, at most `maxChars` long. */
export function snippetAround(content: string, terms: string[], maxChars: number): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const lower = foldText(flat)
  let at = -1
  for (const term of terms) {
    const i = lower.indexOf(termPrefix(term) ?? term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  const start = Math.max(0, Math.min(at < 0 ? 0 : at - Math.floor(maxChars / 3), flat.length - maxChars))
  const end = start + maxChars
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

/** Relevance score used by the in-memory backend: matched distinct terms, rarer/longer first. */
export function termScore(content: string, terms: string[]): number {
  const lower = foldText(content)
  let score = 0
  for (const term of terms) {
    const prefix = termPrefix(term)
    const matched = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRegExp(prefix ?? term)}${prefix ? '' : '($|[^\\p{L}\\p{N}])'}`,
      'u',
    ).test(lower)
    if (matched) score += 1 + term.length / 10
  }
  return score
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
