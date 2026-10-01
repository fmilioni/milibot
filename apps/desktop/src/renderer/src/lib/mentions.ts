export interface MentionTarget {
  id: string
  name: string
}

export type MentionSegment =
  { type: 'text'; text: string } | { type: 'mention'; text: string; target: MentionTarget }

const WORD_CHAR = /[\p{L}\p{N}_-]/u

/**
 * Splits `text` into plain text and `@Name` mentions of known members. Names may contain spaces;
 * the longest matching name wins and a mention must end at a word boundary.
 */
export function splitMentions(text: string, targets: MentionTarget[]): MentionSegment[] {
  if (!text.includes('@') || targets.length === 0) return [{ type: 'text', text }]
  const sorted = [...targets].sort((a, b) => b.name.length - a.name.length)
  const segments: MentionSegment[] = []
  let buffer = ''
  let i = 0
  while (i < text.length) {
    const char = text[i] as string
    const before = i > 0 ? (text[i - 1] as string) : ''
    if (char === '@' && !WORD_CHAR.test(before)) {
      const rest = text.slice(i + 1)
      const target = sorted.find((t) => {
        if (!rest.toLocaleLowerCase().startsWith(t.name.toLocaleLowerCase())) return false
        const after = rest[t.name.length]
        return after === undefined || !WORD_CHAR.test(after)
      })
      if (target) {
        if (buffer) segments.push({ type: 'text', text: buffer })
        buffer = ''
        const raw = text.slice(i, i + 1 + target.name.length)
        segments.push({ type: 'mention', text: raw, target })
        i += raw.length
        continue
      }
    }
    buffer += char
    i++
  }
  if (buffer) segments.push({ type: 'text', text: buffer })
  return segments
}

export interface MentionQuery {
  /** Index of the `@`. */
  start: number
  query: string
}

/** The `@query` being typed right before the caret, if any (drives the composer autocomplete). */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const upToCaret = text.slice(0, caret)
  const at = upToCaret.lastIndexOf('@')
  if (at < 0) return null
  const before = at > 0 ? (upToCaret[at - 1] as string) : ''
  if (before && WORD_CHAR.test(before)) return null
  const query = upToCaret.slice(at + 1)
  if (query.length > 32 || /[\n@]/.test(query) || /\s{2,}/.test(query) || /^\s/.test(query)) return null
  return { start: at, query }
}

export function filterMentionTargets<T extends MentionTarget>(targets: T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return targets
  const starts = targets.filter((t) => t.name.toLocaleLowerCase().startsWith(q))
  const contains = targets.filter((t) => !starts.includes(t) && t.name.toLocaleLowerCase().includes(q))
  return [...starts, ...contains]
}

/** Replaces the active `@query` with the full mention and returns the new text and caret. */
export function insertMention(
  text: string,
  mention: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length
  const inserted = `@${name} `
  const after = text.slice(end).replace(/^ /, '')
  return { text: text.slice(0, mention.start) + inserted + after, caret: mention.start + inserted.length }
}
