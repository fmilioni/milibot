/** One line of a hunk; `oldNo`/`newNo` are null on the side the line does not exist. */
export interface DiffLine {
  type: 'context' | 'add' | 'del'
  content: string
  oldNo: number | null
  newNo: number | null
  /** Followed by "\ No newline at end of file". */
  noNewline?: boolean
  /** The added line a removed one became (and back), paired by position within a change block. */
  pair?: DiffLine
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Text after the second `@@` (the enclosing function or section, when git found one). */
  section: string
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** Hunks of a one-file unified diff (`git diff` output); file headers and anything before the first hunk are skipped. */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = []
  let additions = 0
  let deletions = 0
  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  const lines = patch.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const raw of lines) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[3])
      current = {
        header: raw,
        oldStart: oldNo,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newNo,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        section: (header[5] ?? '').trim(),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    const marker = raw[0]
    const content = raw.slice(1)
    if (marker === '+') {
      current.lines.push({ type: 'add', content, oldNo: null, newNo: newNo++ })
      additions++
    } else if (marker === '-') {
      current.lines.push({ type: 'del', content, oldNo: oldNo++, newNo: null })
      deletions++
    } else if (marker === ' ' || raw === '') {
      current.lines.push({ type: 'context', content, oldNo: oldNo++, newNo: newNo++ })
    } else if (marker === '\\') {
      const last = current.lines.at(-1)
      if (last) last.noNewline = true
    }
  }
  for (const hunk of hunks) pairChanges(hunk.lines)
  return { hunks, additions, deletions }
}

function pairChanges(lines: DiffLine[]): void {
  let i = 0
  while (i < lines.length) {
    const removed: DiffLine[] = []
    while (i < lines.length && (lines[i] as DiffLine).type === 'del') removed.push(lines[i++] as DiffLine)
    let k = 0
    while (i < lines.length && (lines[i] as DiffLine).type === 'add') {
      const added = lines[i++] as DiffLine
      const counterpart = removed[k++]
      if (counterpart) {
        counterpart.pair = added
        added.pair = counterpart
      }
    }
    if (i < lines.length && (lines[i] as DiffLine).type === 'context') i++
  }
}

/** A row of the side-by-side view: removed and added lines of a change block pair up. */
export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  const lines = hunk.lines
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as DiffLine
    if (line.type === 'context') {
      rows.push({ left: line, right: line })
      i++
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (i < lines.length && (lines[i] as DiffLine).type === 'del') removed.push(lines[i++] as DiffLine)
    while (i < lines.length && (lines[i] as DiffLine).type === 'add') added.push(lines[i++] as DiffLine)
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      rows.push({ left: removed[k] ?? null, right: added[k] ?? null })
    }
  }
  return rows
}

/** Rows of a whole diff for a flat (virtualized) list: a header row before each hunk's lines. */
export type DiffRow<T> =
  { kind: 'hunk'; hunk: DiffHunk; key: string } | { kind: 'line'; line: T; key: string }

export function unifiedRowsOf(diff: ParsedDiff): Array<DiffRow<DiffLine>> {
  return diff.hunks.flatMap((hunk, h) => [
    { kind: 'hunk' as const, hunk, key: `h${h}` },
    ...hunk.lines.map((line, l) => ({ kind: 'line' as const, line, key: `h${h}l${l}` })),
  ])
}

export function splitRowsOf(diff: ParsedDiff): Array<DiffRow<SplitRow>> {
  return diff.hunks.flatMap((hunk, h) => [
    { kind: 'hunk' as const, hunk, key: `h${h}` },
    ...splitRows(hunk).map((line, l) => ({ kind: 'line' as const, line, key: `h${h}r${l}` })),
  ])
}
