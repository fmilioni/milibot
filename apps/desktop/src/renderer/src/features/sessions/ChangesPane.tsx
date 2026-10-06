import {
  isPreviewableImagePath,
  type SessionChangedFile,
  type SessionChanges,
  type SessionFileStatus,
} from '@milibot/shared'
import { AlertCircle, ChevronDown, ChevronRight, Columns2, FileDiff, RefreshCw, Rows3 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  FILE_STATUS_LETTER,
  filterChangedFiles,
  readSessionPref,
  splitPath,
  writeSessionPref,
} from '@/features/sessions/lib/session-view'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { type Tone, TONE_SOFT } from '@/lib/tone'
import { AsyncView } from '@/ui/AsyncView'
import { LinkButton } from '@/ui/Button'
import { DiffPanel } from '@/ui/diff/DiffPanel'
import { DiffStat } from '@/ui/diff/DiffStat'
import { type DiffMode, DiffViewer } from '@/ui/diff/DiffViewer'
import { SearchInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

import { ImageDiff } from './ImageDiff'
import { diffKey, useSessionStore } from './store'

const STATUS_TONE: Record<SessionFileStatus, Tone> = {
  added: 'success',
  modified: 'accent',
  deleted: 'danger',
  renamed: 'warning',
}

function StatusBadge({ status }: { status: SessionFileStatus }) {
  const { t } = useTranslation()
  return (
    <Tooltip content={t(`session.changes.status.${status}`)}>
      <span
        className={`flex size-[18px] shrink-0 items-center justify-center rounded font-mono text-2xs font-bold ${TONE_SOFT[STATUS_TONE[status]]}`}
        aria-label={t(`session.changes.status.${status}`)}
      >
        {FILE_STATUS_LETTER[status]}
      </span>
    </Tooltip>
  )
}

const CENTERED =
  'flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-fg-muted'

function Centered({ children }: { children: React.ReactNode }) {
  return <div className={CENTERED}>{children}</div>
}

/**
 * "Changes": what the session changed in its folder, file by file, each unfolding its diff in the list. The
 * list scrolls itself, or with `scrollParent` (a page that already scrolls) grows to its full height and
 * scrolls with that element, open diffs included. When the session changes files the list and the open diffs
 * reload in place: what is on screen (scroll, open files, filter, mode) stays while they do.
 */
export function ChangesPane({
  sessionId,
  scrollParent,
}: {
  sessionId: string
  scrollParent?: HTMLElement | null
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const changes = useSessionStore((s) => s.changes[sessionId])
  const version = useSessionStore((s) => s.changesVersion[sessionId] ?? 0)
  const loadChanges = useSessionStore((s) => s.loadChanges)
  const reload = () => void loadChanges(workspaceId, sessionId)

  // Fresh on every opening, and again each time the session's files change.
  useEffect(() => {
    void loadChanges(workspaceId, sessionId)
  }, [loadChanges, workspaceId, sessionId, version])

  const refresh = (
    <Tooltip content={t('session.changes.refresh')}>
      <button
        type="button"
        onClick={reload}
        disabled={changes?.loading}
        aria-label={t('session.changes.refresh')}
        className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
      >
        <RefreshCw size={13} className={changes?.loading ? 'animate-spin motion-reduce:animate-none' : ''} />
      </button>
    </Tooltip>
  )

  return (
    <AsyncView
      data={changes?.data}
      error={changes?.error}
      onRetry={reload}
      errorText={t('session.changes.loadFailed')}
      className={CENTERED}
    >
      {(data) =>
        data.available ? (
          <ChangedFiles
            sessionId={sessionId}
            data={data}
            refresh={refresh}
            failed={changes?.error === true ? reload : null}
            scrollParent={scrollParent}
          />
        ) : (
          <Centered>
            <FileDiff size={22} className="text-fg-muted" aria-hidden />
            <span className="max-w-[320px]">
              {t(`session.changes.unavailable.${data.reason ?? 'failed'}`)}
            </span>
            {refresh}
          </Centered>
        )
      }
    </AsyncView>
  )
}

function ChangedFiles({
  sessionId,
  data,
  refresh,
  failed,
  scrollParent,
}: {
  sessionId: string
  data: SessionChanges
  refresh: React.ReactNode
  /** The last reload failed (the data shown is the one before it): retries it. */
  failed: (() => void) | null
  scrollParent: HTMLElement | null | undefined
}) {
  const { t } = useTranslation()
  const embedded = scrollParent !== undefined
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const scroller = embedded ? scrollParent : list
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [mode, setMode] = useState<DiffMode>(() =>
    readSessionPref('diffMode') === 'unified' ? 'unified' : 'split',
  )
  const files = useMemo(() => filterChangedFiles(data.files, query), [data.files, query])
  // Kept while a filter is typed, even if the list shrinks under the threshold meanwhile.
  const filterShown = data.files.length > 6 || query !== ''

  const toggle = (path: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }
  const choose = (next: DiffMode) => {
    setMode(next)
    writeSessionPref('diffMode', next)
  }
  const modeButton = (value: DiffMode, Icon: typeof Columns2) => (
    <Tooltip content={t(`session.diff.mode.${value}`)}>
      <button
        type="button"
        aria-pressed={mode === value}
        aria-label={t(`session.diff.mode.${value}`)}
        onClick={() => choose(value)}
        className={cn(
          'focus-ring flex size-6 items-center justify-center rounded-md',
          mode === value ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg',
        )}
      >
        <Icon size={13} />
      </button>
    </Tooltip>
  )

  return (
    <div className={embedded ? 'flex flex-col' : 'flex min-h-0 flex-1 flex-col'}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold text-fg">
          {t('session.changes.files', { count: data.totals.files })}
        </span>
        {data.totals.files > 0 && <DiffStat added={data.totals.additions} removed={data.totals.deletions} />}
        <span className="flex-1" />
        {data.files.length > 0 && (
          <div className="flex items-center rounded-lg border border-border p-0.5">
            {modeButton('split', Columns2)}
            {modeButton('unified', Rows3)}
          </div>
        )}
        {refresh}
      </div>
      {failed && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-danger-tint px-4 py-1.5 text-sm text-fg-secondary"
        >
          <AlertCircle size={13} className="shrink-0 text-danger" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{t('session.changes.loadFailed')}</span>
          <LinkButton onClick={failed}>{t('common.retry')}</LinkButton>
        </div>
      )}
      {data.files.length === 0 ? (
        <Centered>
          <FileDiff size={22} aria-hidden />
          <span className="max-w-[300px]">{t('session.changes.empty')}</span>
        </Centered>
      ) : (
        <>
          {filterShown && (
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t('session.changes.filter')}
              className="shrink-0 px-4 py-2.5"
            />
          )}
          {/* The scroller has no padding of its own: an open file's sticky header sits flush at its top, with no
              strip where the code scrolling under it shows through. */}
          <div ref={setList} className={embedded ? undefined : 'scroll-slim min-h-0 flex-1 overflow-y-auto'}>
            {/* Under the filter the gap comes from its own padding, so it stays the same once a header sticks. */}
            <ul className={filterShown ? 'pb-1.5' : 'py-1.5'}>
              {files.map((file) => (
                <FileRow
                  key={file.path}
                  sessionId={sessionId}
                  file={file}
                  open={open.has(file.path)}
                  mode={mode}
                  scroller={scroller}
                  onToggle={() => toggle(file.path)}
                />
              ))}
              {files.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-fg-muted">
                  {t('session.changes.noMatch')}
                </li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

function FileRow({
  sessionId,
  file,
  open,
  mode,
  scroller,
  onToggle,
}: {
  sessionId: string
  file: SessionChangedFile
  open: boolean
  mode: DiffMode
  scroller: HTMLElement | null
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const { name, dir } = splitPath(file.path)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className={open ? 'border-b border-border' : ''}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'focus-ring group flex w-full items-center gap-2.5 py-1.5 pr-4 pl-2 text-left',
          // The sticky header covers the code scrolling under it, so its hover tint is pre-blended to stay opaque.
          open
            ? 'sticky top-0 z-sticky bg-surface-2 hover:bg-[color-mix(in_srgb,var(--surface-3)_60%,var(--surface-2))]'
            : 'hover:bg-surface-3/60',
        )}
      >
        <Chevron size={13} className="shrink-0 text-fg-muted" aria-hidden />
        <StatusBadge status={file.status} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm text-fg">{name}</span>
          {(dir || file.oldPath) && (
            <span className="truncate font-mono text-xs text-fg-muted">
              {file.oldPath ? t('session.changes.renamedFrom', { path: file.oldPath }) : dir}
            </span>
          )}
        </span>
        {file.binary ? (
          <span className="shrink-0 text-xs text-fg-muted">{t('session.changes.binary')}</span>
        ) : (
          <DiffStat added={file.additions} removed={file.deletions} />
        )}
      </button>
      {open && <FileDiffBody sessionId={sessionId} file={file} mode={mode} scroller={scroller} />}
    </li>
  )
}

/** The diff of a file unfolded in the list (the images side by side for a changed picture). */
function FileDiffBody({
  sessionId,
  file,
  mode,
  scroller,
}: {
  sessionId: string
  file: SessionChangedFile
  mode: DiffMode
  scroller: HTMLElement | null
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const entry = useSessionStore((s) => s.fileDiffs[diffKey(sessionId, file.path)])
  const loadFileDiff = useSessionStore((s) => s.loadFileDiff)
  // A stale diff stays on screen while it reloads (no spinner, the viewer and its scroll are kept).
  const needsLoad = !entry || (!entry.loading && (entry.stale === true || (!entry.data && !entry.error)))

  useEffect(() => {
    if (needsLoad) void loadFileDiff(workspaceId, sessionId, file.path)
  }, [needsLoad, loadFileDiff, workspaceId, sessionId, file.path])

  const oneSided = file.status === 'added' || file.status === 'deleted'
  return (
    <DiffPanel
      className="border-t border-border"
      truncated={entry?.data?.truncated}
      data={entry?.data}
      error={entry?.error}
      onRetry={() => void loadFileDiff(workspaceId, sessionId, file.path)}
      errorText={t('session.diff.loadFailed')}
    >
      {(loaded) =>
        loaded.binary ? (
          isPreviewableImagePath(loaded.path) ? (
            <div className="flex max-h-[560px] flex-col">
              <ImageDiff sessionId={sessionId} file={file} />
            </div>
          ) : (
            <p className="px-4 py-4 text-center text-sm text-fg-muted">{t('session.diff.binary')}</p>
          )
        ) : (
          <DiffViewer
            patch={loaded.patch}
            language={loaded.language}
            mode={oneSided ? 'unified' : mode}
            scrollParent={scroller}
          />
        )
      }
    </DiffPanel>
  )
}
