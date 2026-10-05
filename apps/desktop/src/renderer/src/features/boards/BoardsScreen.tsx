import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type Board, fullListIndex, localDate } from '@milibot/shared'
import { Folder, PanelLeftClose, Plus, SquareKanban } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type BoardFilter, boardProgress, boardsIn } from '@/features/boards/lib/boards'
import { useProjectStore } from '@/features/projects/store'
import { screenIs, toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatDueDate } from '@/lib/calendar'
import { cn } from '@/lib/cn'
import { EmptyState } from '@/ui/EmptyState'
import { Tooltip } from '@/ui/Tooltip'

import { BoardDialog } from './BoardDialog'
import { BoardProgressBar } from './BoardParts'
import { BoardView } from './BoardView'
import { useBoardStore } from './store'

const TABS = ['active', 'done', 'archived'] as const

/** The boards: the list (active, done, archived; collapsible, reordered by dragging) and the open board. */
export function BoardsScreen() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const screen = useAppStore((s) => screenIs(s.screen, 'boards'))
  const openBoards = useAppStore((s) => s.openBoards)
  const showToast = useAppStore((s) => s.showToast)
  const boards = useBoardStore((s) => (s.workspaceId === workspaceId ? s.boards : []))
  const loaded = useBoardStore((s) => s.workspaceId === workspaceId && s.loaded)
  const load = useBoardStore((s) => s.load)
  const collapsed = useBoardStore((s) => s.listCollapsed)
  const setCollapsed = useBoardStore((s) => s.setListCollapsed)
  const reorderBoard = useBoardStore((s) => s.reorderBoard)
  const [filter, setFilter] = useState<BoardFilter>('active')
  const [creating, setCreating] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

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

  // The tab shows part of the boards: the drop lands before the board it is over in the whole list.
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const ids = listed.map((b) => b.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const index = fullListIndex(
      boards.map((b) => b.id),
      ids,
      String(active.id),
      to,
    )
    void toastOnError(reorderBoard(workspaceId, String(active.id), index))
  }

  return (
    <main className="flex min-w-0 flex-1 bg-bg" aria-label={t('boards.title')}>
      {!collapsed && (
        <section
          aria-label={t('boards.list.label')}
          className="flex w-[256px] shrink-0 flex-col border-r border-border bg-surface"
        >
          <div className="drag-region flex h-14 shrink-0 items-center gap-1 pr-3 pl-4">
            <h1 className="flex-1 truncate text-xl font-bold text-fg">{t('boards.title')}</h1>
            <Tooltip content={t('boards.list.collapse')}>
              <button
                type="button"
                aria-label={t('boards.list.collapse')}
                onClick={() => setCollapsed(true)}
                className="no-drag focus-ring hit flex size-8 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-3 hover:text-fg"
              >
                <PanelLeftClose size={16} />
              </button>
            </Tooltip>
            <Tooltip content={t('boards.new')}>
              <button
                type="button"
                aria-label={t('boards.new')}
                onClick={() => setCreating(true)}
                className="no-drag focus-ring hit flex size-8 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
              >
                <Plus size={16} />
              </button>
            </Tooltip>
          </div>
          <div
            role="tablist"
            aria-label={t('boards.title')}
            className="mx-3 mb-3 flex gap-0.5 rounded-lg bg-surface-3 p-[3px]"
          >
            {TABS.map((value) => {
              const on = value === filter
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFilter(value)}
                  className={cn(
                    'focus-ring flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1 text-xs whitespace-nowrap',
                    on ? 'bg-surface-2 font-semibold text-fg shadow-sm' : 'text-fg-secondary hover:text-fg',
                  )}
                >
                  {t(`boards.filters.${value}`)}
                  <span className="text-fg-secondary tabular-nums">{counts[value]}</span>
                </button>
              )
            })}
          </div>
          <nav
            aria-label={t('boards.list.label')}
            className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3"
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={listed.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                <ul className="flex flex-col gap-1">
                  {listed.map((board) => (
                    <BoardListItem
                      key={board.id}
                      board={board}
                      selected={board.id === selected?.id}
                      onSelect={() => openBoards(board.id)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            {loaded && listed.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-fg-secondary">{t('boards.emptyFilter')}</p>
            )}
          </nav>
        </section>
      )}
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: board.id,
  })
  const progress = boardProgress(board.counts)
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-sticky opacity-80')}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        {...attributes}
        {...listeners}
        aria-roledescription={undefined}
        aria-describedby={undefined}
        className={cn(
          'focus-inset relative flex w-full flex-col gap-2 rounded-card border px-3 py-2.5 text-left',
          selected ? 'border-border bg-surface-2' : 'border-transparent hover:bg-surface-2',
          isDragging && 'shadow-[0_8px_24px_rgba(0,0,0,0.18)]',
        )}
      >
        {selected && (
          <span className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-accent" aria-hidden />
        )}
        <span className="line-clamp-3 text-base font-bold text-fg">{board.title}</span>
        <BoardProgressBar counts={board.counts} className="h-1" />
        <span className="flex items-center gap-2 text-xs text-fg-secondary">
          {project && (
            <span className="flex min-w-0 items-center gap-1 truncate rounded-[5px] bg-surface-3 px-1.5 py-0.5">
              <Folder size={11} className="shrink-0" aria-hidden />
              <span className="truncate">{project.name}</span>
            </span>
          )}
          <span className="shrink-0 tabular-nums">
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
    </li>
  )
}
