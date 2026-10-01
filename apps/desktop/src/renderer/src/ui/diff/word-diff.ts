import type { Segment } from './highlight'

/** Characters `[start, end)` of a line. */
export type Range = [start: number, end: number]

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu
const MAX_CHARS = 2000
const MAX_TOKENS = 400
/** Below this share of unchanged (non-space) text the line was rewritten: marking all of it is noise. */
const MIN_KEPT = 0.4

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/** Which tokens of `a` and `b` belong to their longest common subsequence. */
function commonTokens(a: string[], b: string[]): [boolean[], boolean[]] {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number)
    }
  }
  const keepA = new Array<boolean>(n).fill(false)
  const keepB = new Array<boolean>(m).fill(false)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keepA[i++] = true
      keepB[j++] = true
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) i++
    else j++
  }
  return [keepA, keepB]
}

/** Ranges of the tokens not kept, without spaces at their edges; ranges apart only by spaces become one. */
function changedRanges(text: string, tokens: string[], kept: (index: number) => boolean): Range[] {
  const ranges: Range[] = []
  let pos = 0
  tokens.forEach((token, index) => {
    const start = pos
    pos += token.length
    if (kept(index)) return
    const last = ranges.at(-1)
    if (last && /^\s*$/.test(text.slice(last[1], start))) last[1] = pos
    else ranges.push([start, pos])
  })
  return ranges.map(([start, end]): Range => {
    const slice = text.slice(start, end)
    if (!slice.trim()) return [start, end]
    return [start + slice.length - slice.trimStart().length, end - slice.length + slice.trimEnd().length]
  })
}

function keptShare(text: string, ranges: Range[]): number {
  const visible = text.replace(/\s/g, '').length
  if (visible === 0) return 0
  const changed = ranges.reduce(
    (sum, [start, end]) => sum + text.slice(start, end).replace(/\s/g, '').length,
    0,
  )
  return (visible - changed) / visible
}

/**
 * What changed between a removed line and the added line paired with it, word by word; null when there is
 * nothing worth marking (identical, too long, or rewritten).
 */
export function intraLineRanges(before: string, after: string): { before: Range[]; after: Range[] } | null {
  if (before === after || before.length > MAX_CHARS || after.length > MAX_CHARS) return null
  const a = tokenize(before)
  const b = tokenize(after)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++
  const middleA = a.slice(prefix, a.length - suffix)
  const middleB = b.slice(prefix, b.length - suffix)
  if (middleA.length > MAX_TOKENS || middleB.length > MAX_TOKENS) return null
  const [keepA, keepB] = commonTokens(middleA, middleB)
  const keptIn = (keep: boolean[], total: number) => (index: number) =>
    index < prefix || index >= total - suffix || (keep[index - prefix] as boolean)
  const ranges = {
    before: changedRanges(before, a, keptIn(keepA, a.length)),
    after: changedRanges(after, b, keptIn(keepB, b.length)),
  }
  const shorter = before.replace(/\s/g, '').length <= after.replace(/\s/g, '').length ? 'before' : 'after'
  if (keptShare(shorter === 'before' ? before : after, ranges[shorter]) < MIN_KEPT) return null
  return ranges
}

/** Splits highlighted runs at the ranges' edges and adds `className` to the runs inside them. */
export function markSegments(segments: Segment[], ranges: Range[], className: string): Segment[] {
  if (ranges.length === 0) return segments
  const out: Segment[] = []
  let offset = 0
  let r = 0
  for (const segment of segments) {
    const length = segment.text.length
    let start = 0
    while (start < length) {
      const at = offset + start
      while (r < ranges.length && (ranges[r] as Range)[1] <= at) r++
      const range = ranges[r]
      let cut = length
      let marked = false
      if (range && range[0] < offset + length) {
        if (range[0] > at) cut = range[0] - offset
        else {
          cut = Math.min(length, range[1] - offset)
          marked = true
        }
      }
      out.push({
        text: segment.text.slice(start, cut),
        className: marked ? `${segment.className} ${className}`.trim() : segment.className,
      })
      start = cut
    }
    offset += length
  }
  return out
}
