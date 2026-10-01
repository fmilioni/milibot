import { type Board, localDate } from '@milibot/shared'
import { Plus, SquareKanban } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type BoardFilter, boardProgress, boardsIn } from '@/features/boards/lib/boards'
import { useProjectStore } from '@/features/projects/store'
import { screenIs, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatDueDate } from '@/lib/calendar'
import { cn } from '@/lib/cn'
import { EmptyState } from '@/ui/EmptyState'
import { Segmented } from '@/ui/Segmented'
import { Tooltip } from '@/ui/Tooltip'

import { BoardDialog } from './BoardDialog'
import { BoardProgressBar } from './BoardParts'
import { BoardView } from './BoardView'
import { useBoardStore } from './store'

/** The boards: the list (active, done, archived) and the open board. */
export function BoardsScreen() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const screen = useAppStore((s) => screenIs(s.screen, 'boards'))
  const openBoards = useAppStore((s) => s.openBoards)
  const showToast = useAppStore((s) => s.showToast)
  const boards = useBoardStore((s) => (s.workspaceId === workspaceId ? s.boards : []))
  const loaded = useBoardStore((s) => s.workspaceId === workspaceId && s.loaded)
  const load = useBoardStore((s) => s.load)
  const [filter, setFilter] = useState<BoardFilter>('active')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void load(workspaceId).catch(() => showToast('error'))
  }, [load, workspaceId, showToast])

  const listed = useMemo(() => boardsIn(boards, filter), [boards, filter])
  const selected = boards.find((b) => b.id === screen?.boardId) ?? listed[0] ?? null

  // Opening a board (or its status changing) shows the tab it belongs to.
  const opened = boards.find((b) => b.id === screen?.boardId)
  const openedFilter: BoardFilter | null = opened
    ? opened.archivedAt !== null
      ? 'archived'
      : opened.status
    : null
  const openedKey = opened && `${opened.id}:${openedFilter}`
  const [followed, setFollowed] = useState<string | null>(null)
  if (openedKey && openedFilter && openedKey !== followed) {
    setFollowed(openedKey)
    setFilter(openedFilter)
  }

  const counts = {
    active: boardsIn(boards, 'active').length,
    done: boardsIn(boards, 'done').length,
    archived: boardsIn(boards, 'archived').length,
  }

  return (
    <main className="flex min-w-0 flex-1 bg-bg" aria-label={t('boards.title')}>
      <section className="flex w-[320px] shrink-0 flex-col border-r border-border bg-surface">
        <div className="drag-region flex h-16 shrink-0 items-center justify-between gap-2 px-4">
          <h1 className="text-xl font-bold text-fg">{t('boards.title')}</h1>
          <Tooltip content={t('boards.new')}>
            <button
              type="button"
              aria-label={t('boards.new')}
              onClick={() => setCreating(true)}
              className="no-drag focus-ring flex size-7 items-center justify-center rounded-[7px] border border-border text-fg-secondary hover:bg-surface-3"
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="px-4 pb-3">
          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            label={t('boards.title')}
            role="tab"
            options={(['active', 'done', 'archived'] as const).map((value) => ({
              value,
              label: t(`boards.filters.${value}`),
              count: counts[value],
            }))}
          />
        </div>
        <nav className="scroll-slim flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pb-3">
          {listed.map((board) => (
            <BoardListItem
              key={board.id}
              board={board}
              selected={board.id === selected?.id}
              onSelect={() => openBoards(board.id)}
            />
          ))}
          {loaded && listed.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-fg-muted">{t('boards.emptyFilter')}</p>
          )}
        </nav>
      </section>
      {selected ? (
        <BoardView key={selected.id} board={selected} />
      ) : (
        <EmptyState
          icon={SquareKanban}
          title={t('boards.empty.title')}
          hint={t('boards.empty.hint')}
          className="drag-region win:pr-caption-10"
          action={
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="no-drag focus-ring mt-1 rounded-lg bg-accent px-3.5 py-1.5 text-base font-semibold text-on-accent"
            >
              {t('boards.new')}
            </button>
          }
        />
      )}
      {creating && (
        <BoardDialog
          onClose={() => setCreating(false)}
          onSaved={(board) => {
            setCreating(false)
            openBoards(board.id)
          }}
        />
      )}
    </main>
  )
}

function BoardListItem({
  board,
  selected,
  onSelect,
}: {
  board: Board
  selected: boolean
  onSelect: () => void
}) {
  const { t, i18n } = useTranslation()
  const now = useNow(60_000)
  const project = useProjectStore((s) =>
    board.projectId ? s.projects.find((p) => p.id === board.projectId) : null,
  )
  const progress = boardProgress(board.counts)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'focus-inset flex flex-col gap-1.5 rounded-[9px] px-2.5 py-2.5 text-left',
        selected ? 'bg-surface-3' : 'hover:bg-surface-2',
      )}
    >
      <span className="line-clamp-2 text-base font-semibold text-fg">{board.title}</span>
      <BoardProgressBar counts={board.counts} className="h-1" />
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        {project && (
          <span className="truncate rounded-[5px] bg-surface-3 px-1.5 py-px text-2xs text-fg-secondary">
            {project.name}
          </span>
        )}
        <span className="shrink-0">
          {t('boards.progressShort', { done: progress.done, total: progress.total })}
        </span>
        <span className="flex-1" />
        {board.dueDate && (
          <span className="shrink-0">
            {t('boards.until', { date: formatDueDate(board.dueDate, i18n.language, localDate(now)) })}
          </span>
        )}
      </span>
    </button>
  )
}
