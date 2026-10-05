export type LinkKind = 'url'

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
}

const TRAILING_PUNCTUATION = /[.,;:!?'"»”’]$/

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    if (TRAILING_PUNCTUATION.test(url)) url = url.slice(0, -1)
    else if (url.endsWith(')') && count(url, ')') > count(url, '(')) url = url.slice(0, -1)
    else return url
  }
}

const urlMatcher: Matcher = {
  kind: 'url',
  pattern: /(?<![\p{L}\p{N}_])https?:\/\/[^\s<>"]+/gu,
  toToken: (raw) => {
    const url = trimUrl(raw)
    return URL.canParse(url) ? { text: url, href: url } : null
  },
}

const DEFAULT_MATCHERS: readonly Matcher[] = [urlMatcher]

interface Found {
  index: number
  token: LinkToken
}

function firstMatch(text: string, from: number, matcher: Matcher): Found | null {
  const pattern = new RegExp(matcher.pattern.source, matcher.pattern.flags)
  pattern.lastIndex = from
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
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
  let cursor = 0
  for (;;) {
    let best: Found | null = null
    for (const matcher of matchers) {
      const found = firstMatch(text, cursor, matcher)
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
