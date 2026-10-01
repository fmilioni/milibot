import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'

import { cn } from '@/lib/cn'

import { highlightLine } from './highlight'
import {
  type DiffHunk,
  type DiffLine,
  type DiffRow,
  parseUnifiedDiff,
  type SplitRow,
  splitRowsOf,
  unifiedRowsOf,
} from './unified-diff'
import { intraLineRanges, markSegments, type Range } from './word-diff'

export type DiffMode = 'split' | 'unified'

/** One line of code with syntax colors (plain text when the language is unknown), `marks` get `markClass`. */
export const Code = memo(function Code({
  text,
  language,
  marks,
  markClass = '',
}: {
  text: string
  language: string | undefined
  marks?: Range[] | null
  markClass?: string
}) {
  const segments = useMemo(() => {
    const highlighted = highlightLine(text, language)
    if (!marks?.length) return highlighted
    return markSegments(highlighted ?? [{ text, className: '' }], marks, markClass)
  }, [text, language, marks, markClass])
  if (!segments) return <>{text || ' '}</>
  return (
    <>
      {segments.map((segment, i) =>
        segment.className ? (
          <span key={i} className={segment.className}>
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  )
})

const LINE_BG: Record<DiffLine['type'], string> = {
  add: 'bg-[var(--diff-add-bg)]',
  del: 'bg-[var(--diff-del-bg)]',
  context: '',
}
const NUMBER_BG: Record<DiffLine['type'], string> = {
  add: 'bg-[var(--diff-add-gutter)]',
  del: 'bg-[var(--diff-del-gutter)]',
  context: '',
}
const MARKER: Record<DiffLine['type'], string> = { add: '+', del: '−', context: ' ' }
const WORD_MARK: Record<DiffLine['type'], string> = {
  add: 'diff-word-add',
  del: 'diff-word-del',
  context: '',
}

const wordMarks = new WeakMap<DiffLine, Range[] | null>()

/** What changed inside a line against its pair, computed once per line and only for lines on screen. */
function marksOf(line: DiffLine): Range[] | null {
  if (!line.pair) return null
  const cached = wordMarks.get(line)
  if (cached !== undefined) return cached
  const [del, add] = line.type === 'del' ? [line, line.pair] : [line.pair, line]
  const ranges = intraLineRanges(del.content, add.content)
  wordMarks.set(del, ranges?.before ?? null)
  wordMarks.set(add, ranges?.after ?? null)
  return (line.type === 'del' ? ranges?.before : ranges?.after) ?? null
}

function LineNumber({ value, type }: { value: number | null; type: DiffLine['type'] }) {
  return (
    <span
      className={`w-11 shrink-0 pr-2 text-right text-fg-muted/80 select-none ${NUMBER_BG[type]}`}
      aria-hidden
    >
      {value ?? ''}
    </span>
  )
}

function CodeCell({
  line,
  language,
  showMarker = true,
}: {
  line: DiffLine
  language: string | undefined
  showMarker?: boolean
}) {
  const { t } = useTranslation()
  return (
    <span className={`flex min-w-0 flex-1 ${LINE_BG[line.type]}`}>
      {showMarker && (
        <span
          className={cn(
            'w-4 shrink-0 text-center select-none',
            line.type === 'add' ? 'text-success' : line.type === 'del' ? 'text-danger' : 'text-fg-muted',
          )}
          aria-label={line.type === 'context' ? undefined : t(`session.diff.${line.type}`)}
        >
          {MARKER[line.type]}
        </span>
      )}
      <span className="code-tokens min-w-0 flex-1 pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
        <Code
          text={line.content}
          language={language}
          marks={marksOf(line)}
          markClass={WORD_MARK[line.type]}
        />
        {line.noNewline && (
          <span className="ml-2 text-fg-muted italic select-none">{t('session.diff.noNewline')}</span>
        )}
      </span>
    </span>
  )
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="flex gap-3 border-y border-border bg-[var(--diff-hunk-bg)] px-3 py-1 text-fg-muted select-none">
      <span className="shrink-0">
        @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </span>
      {hunk.section && <span className="truncate">{hunk.section}</span>}
    </div>
  )
}

function UnifiedLine({ line, language }: { line: DiffLine; language: string | undefined }) {
  return (
    <div className="flex">
      <LineNumber value={line.oldNo} type={line.type} />
      <LineNumber value={line.newNo} type={line.type} />
      <CodeCell line={line} language={language} />
    </div>
  )
}

function SplitSide({ line, language }: { line: DiffLine | null; language: string | undefined }) {
  if (!line) return <span className="flex-1 bg-[var(--diff-empty-bg)]" />
  return (
    <span className="flex min-w-0 flex-1">
      <LineNumber value={line.type === 'add' ? line.newNo : line.oldNo} type={line.type} />
      <CodeCell line={line} language={language} />
    </span>
  )
}

function SplitLine({ row, language }: { row: SplitRow; language: string | undefined }) {
  const same = row.left !== null && row.left === row.right
  return (
    <div className="flex">
      <SplitSide line={row.left} language={language} />
      <span className="w-px shrink-0 bg-border" aria-hidden />
      {same ? (
        <span className="flex min-w-0 flex-1">
          <LineNumber value={row.right?.newNo ?? null} type="context" />
          <CodeCell line={row.right as DiffLine} language={language} />
        </span>
      ) : (
        <SplitSide line={row.right} language={language} />
      )}
    </div>
  )
}

const LINE_HEIGHT = 19
const HUNK_HEIGHT = 29

/**
 * A file's diff, side by side or unified, virtualized so large files stay responsive. It fills its parent,
 * or with `maxHeight` takes the height of its content up to that (inline in a list), or with `scrollParent`
 * takes its whole height and scrolls with that element (a list of files that scrolls as one page).
 */
export function DiffViewer({
  patch,
  language,
  mode,
  maxHeight,
  scrollParent,
}: {
  patch: string
  language: string | undefined
  mode: DiffMode
  maxHeight?: number
  scrollParent?: HTMLElement | null
}) {
  const { t } = useTranslation()
  const diff = useMemo(() => parseUnifiedDiff(patch), [patch])
  const rows = useMemo<Array<DiffRow<DiffLine> | DiffRow<SplitRow>>>(
    () => (mode === 'split' ? splitRowsOf(diff) : unifiedRowsOf(diff)),
    [diff, mode],
  )
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const estimated = rows.reduce((sum, row) => sum + (row.kind === 'hunk' ? HUNK_HEIGHT : LINE_HEIGHT), 0)
  if (diff.hunks.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-fg-muted">{t('session.diff.noTextChanges')}</p>
  }
  const item = (row: DiffRow<DiffLine> | DiffRow<SplitRow>) =>
    row.kind === 'hunk' ? (
      <HunkHeader hunk={row.hunk} />
    ) : mode === 'split' ? (
      <SplitLine row={row.line as SplitRow} language={language} />
    ) : (
      <UnifiedLine line={row.line as DiffLine} language={language} />
    )
  if (scrollParent !== undefined) {
    if (!scrollParent) return null
    return (
      <Virtuoso
        className="font-mono text-sm leading-[19px]"
        customScrollParent={scrollParent}
        data={rows}
        computeItemKey={(_, row) => row.key}
        increaseViewportBy={400}
        itemContent={(_, row) => item(row)}
      />
    )
  }
  return (
    <Virtuoso
      className={cn(
        'scroll-slim font-mono text-sm leading-[19px]',
        maxHeight ? 'shrink-0' : 'min-h-0 flex-1',
      )}
      style={maxHeight ? { height: Math.min(contentHeight ?? estimated, maxHeight) } : undefined}
      totalListHeightChanged={maxHeight ? setContentHeight : undefined}
      data={rows}
      computeItemKey={(_, row) => row.key}
      increaseViewportBy={400}
      itemContent={(_, row) => item(row)}
    />
  )
}
