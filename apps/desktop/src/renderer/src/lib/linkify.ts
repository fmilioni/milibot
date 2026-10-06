import { isWorkspaceFilePath, REF_ID_PATTERN, WORKSPACE_PATH_PATTERN } from '@milibot/shared'

/** `ref`: an id of the app (`bcd_…`); `path`: a file under `/workspace/`. */
export type LinkKind = 'url' | 'ref' | 'path'

export interface LinkToken {
  type: 'link'
  kind: LinkKind
  text: string
  href: string
}

export type Token = { type: 'text'; text: string } | LinkToken

interface Matcher {
  kind: LinkKind
  /** Searched from each position with `lastIndex`, so it is used with the `g` flag. */
  pattern: RegExp
  /** The link a raw match stands for (its `text` a prefix of the match), or null to skip the match. */
  toToken: (raw: string) => { text: string; href: string } | null
  /** Its matches inside inline code (`…`) stay text, as markdown keeps code as code. */
  notInCode?: boolean
}

const TRAILING_PUNCTUATION = /[.,;:!?'"»”’]$/

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

/** Drops the sentence's punctuation after a URL or path, and a `)` that closes none of its own. */
function trimTrailing(raw: string): string {
  let value = raw
  for (;;) {
    if (TRAILING_PUNCTUATION.test(value)) value = value.slice(0, -1)
    else if (value.endsWith(')') && count(value, ')') > count(value, '(')) value = value.slice(0, -1)
    else return value
  }
}

const urlMatcher: Matcher = {
  kind: 'url',
  pattern: /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"]+/gu,
  toToken: (raw) => {
    const url = trimTrailing(raw)
    return URL.canParse(url) ? { text: url, href: url } : null
  },
}

const refMatcher: Matcher = {
  kind: 'ref',
  pattern: REF_ID_PATTERN,
  toToken: (raw) => ({ text: raw, href: raw }),
  notInCode: true,
}

const pathMatcher: Matcher = {
  kind: 'path',
  pattern: WORKSPACE_PATH_PATTERN,
  toToken: (raw) => {
    const path = trimTrailing(raw)
    return isWorkspaceFilePath(path) ? { text: path, href: path } : null
  },
}

const DEFAULT_MATCHERS: readonly Matcher[] = [urlMatcher, refMatcher, pathMatcher]

/** Ids and paths only (markdown finds its own URLs). */
export const REF_MATCHERS: readonly Matcher[] = [refMatcher, pathMatcher]

interface Found {
  index: number
  token: LinkToken
}

type Span = readonly [start: number, end: number]

/** The inline code spans (`…`) of a text. */
function codeSpans(text: string): Span[] {
  return [...text.matchAll(/`[^`\n]+`/g)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  )
}

function firstMatch(text: string, from: number, matcher: Matcher, code: readonly Span[]): Found | null {
  const pattern = new RegExp(matcher.pattern.source, matcher.pattern.flags)
  pattern.lastIndex = from
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const at = match.index
    if (matcher.notInCode && code.some(([start, end]) => at > start && at < end)) continue
    const link = match[0] ? matcher.toToken(match[0]) : null
    if (link?.text) return { index: match.index, token: { type: 'link', kind: matcher.kind, ...link } }
    if (!match[0]) pattern.lastIndex++
  }
  return null
}

/**
 * Splits `text` into plain text and links. The leftmost match wins, the longest one on a tie;
 * matches never overlap.
 */
export function tokenize(text: string, matchers: readonly Matcher[] = DEFAULT_MATCHERS): Token[] {
  const tokens: Token[] = []
  const code = text.includes('`') ? codeSpans(text) : []
  let cursor = 0
  for (;;) {
    let best: Found | null = null
    for (const matcher of matchers) {
      const found = firstMatch(text, cursor, matcher, code)
      if (
        found &&
        (!best ||
          found.index < best.index ||
          (found.index === best.index && found.token.text.length > best.token.text.length))
      ) {
        best = found
      }
    }
    if (!best) break
    if (best.index > cursor) tokens.push({ type: 'text', text: text.slice(cursor, best.index) })
    tokens.push(best.token)
    cursor = best.index + best.token.text.length
  }
  if (cursor < text.length || tokens.length === 0) tokens.push({ type: 'text', text: text.slice(cursor) })
  return tokens
}
