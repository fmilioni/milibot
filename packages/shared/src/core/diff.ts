export interface LineDiff {
  /** Lines prefixed with `+`, `-` or ` ` (context); `@@` marks skipped unchanged lines. */
  diff: string
  added: number
  removed: number
}

const CONTEXT_LINES = 2
const MAX_LCS_CELLS = 4_000_000

export interface LineOp {
  op: '+' | '-' | ' '
  text: string
}

/** Longest-common-subsequence line ops turning `a` into `b` (common prefix/suffix trimmed first). */
export function lineOps(a: readonly string[], b: readonly string[]): LineOp[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const ops: LineOp[] = a.slice(0, head).map((text) => ({ op: ' ', text }))
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const text of midA) ops.push({ op: '-', text })
    for (const text of midB) ops.push({ op: '+', text })
  } else {
    const n = midA.length
    const m = midB.length
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      const row = lcs[i] as Uint32Array
      const next = lcs[i + 1] as Uint32Array
      for (let j = m - 1; j >= 0; j--) {
        row[j] =
          midA[i] === midB[j]
            ? (next[j + 1] as number) + 1
            : Math.max(next[j] as number, row[j + 1] as number)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ op: ' ', text: midA[i] as string })
        i++
        j++
      } else if (i < n && (j >= m || (lcs[i + 1]?.[j] as number) >= (lcs[i]?.[j + 1] as number))) {
        ops.push({ op: '-', text: midA[i] as string })
        i++
      } else {
        ops.push({ op: '+', text: midB[j] as string })
        j++
      }
    }
  }
  for (const text of a.slice(a.length - tail)) ops.push({ op: ' ', text })
  return ops
}

/** Line diff of two texts with a little context around each change. */
export function lineDiff(before: string, after: string): LineDiff {
  const ops = lineOps(before === '' ? [] : before.split('\n'), after === '' ? [] : after.split('\n'))
  const keep = ops.map((o, index) =>
    ops.slice(Math.max(0, index - CONTEXT_LINES), index + CONTEXT_LINES + 1).some((near) => near.op !== ' '),
  )
  const lines: string[] = []
  let skipped = false
  ops.forEach((o, index) => {
    if (!keep[index]) {
      skipped = true
      return
    }
    if (skipped) lines.push('@@')
    skipped = false
    lines.push(`${o.op}${o.text}`)
  })
  if (skipped && lines.length) lines.push('@@')
  return {
    diff: lines.join('\n'),
    added: ops.filter((o) => o.op === '+').length,
    removed: ops.filter((o) => o.op === '-').length,
  }
}

export interface DiffLine {
  op: '+' | '-' | ' ' | 'gap'
  text: string
}

export function parseDiff(diff: string): DiffLine[] {
  if (!diff) return []
  return diff.split('\n').map((line) => {
    if (line === '@@') return { op: 'gap', text: '' }
    const op = line[0]
    return op === '+' || op === '-' ? { op, text: line.slice(1) } : { op: ' ', text: line.slice(1) }
  })
}
