import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type Board, type BoardCard, type BoardCardLink, type BoardCardStatus } from '@milibot/shared'
import {
  ChevronLeft,
  ChevronRight,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Image,
  Link2,
  ListChecks,
  MessageSquare,
  PenTool,
  Plus,
  Terminal,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CARD_TONE, COLUMN_PREFIX } from '@/features/boards/lib/boards'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { TONE_FILL } from '@/lib/tone'

import { DueChip } from './BoardParts'
import { AssigneeStack, LabelChip } from './CardPeople'
import { useBoardStore } from './store'

export function Column({
  board,
  status,
  cards,
  onOpenCard,
  onCollapse,
}: {
  board: Board
  status: BoardCardStatus
  cards: BoardCard[]
  onOpenCard: (id: string) => void
  onCollapse?: () => void
}) {
  const { t } = useTranslation()
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status}` })
  return (
    <div
      ref={setNodeRef}
      className={cn('flex min-w-0 flex-1 flex-col rounded-xl bg-surface', isOver && 'ring-1 ring-accent/40')}
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <span className={`size-2 rounded-full ${TONE_FILL[CARD_TONE[status]]}`} aria-hidden />
        <h3 className="text-sm font-bold text-fg">{t(`boards.columns.${status}`)}</h3>
        <span className="text-sm text-fg-muted">{cards.length}</span>
        <span className="flex-1" />
        {onCollapse && (
          <button
            type="button"
            aria-label={t('boards.collapse')}
            onClick={onCollapse}
            className="focus-ring rounded text-fg-muted hover:text-fg"
          >
            <ChevronRight size={14} />
          </button>
        )}
      </div>
      <div className="scroll-slim flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2.5">
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} onOpen={() => onOpenCard(card.id)} />
          ))}
        </SortableContext>
        {status === 'todo' && board.archivedAt === null && <AddCard board={board} />}
      </div>
    </div>
  )
}

export function CollapsedColumn({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useTranslation()
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}dropped` })
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onOpen}
      aria-label={t('boards.expandDropped', { count })}
      className={cn(
        'focus-ring flex w-11 shrink-0 flex-col items-center gap-2.5 rounded-xl bg-surface py-3 hover:bg-surface-2',
        isOver && 'ring-1 ring-danger/40',
      )}
    >
      <span className={`size-2 rounded-full ${TONE_FILL.danger}`} aria-hidden />
      <span className="text-sm font-semibold text-fg-muted">{count}</span>
      <span className="text-sm font-bold text-fg-secondary [writing-mode:vertical-rl]">
        {t('boards.columns.dropped')}
      </span>
      <ChevronLeft size={13} className="mt-auto text-fg-muted" aria-hidden />
    </button>
  )
}

function SortableCard({ card, onOpen }: { card: BoardCard; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-40' : ''}
      {...attributes}
      {...listeners}
    >
      <CardTile card={card} onOpen={onOpen} />
    </div>
  )
}

const LINK_ICON: Record<BoardCardLink['kind'], typeof ListChecks> = {
  plan: ListChecks,
  session: Terminal,
  design: PenTool,
  pr: GitPullRequest,
  commit: GitCommitHorizontal,
  url: Link2,
}

export function CardTile({
  card,
  onOpen,
  overlay = false,
}: {
  card: BoardCard
  onOpen?: () => void
  overlay?: boolean
}) {
  const { t } = useTranslation()
  const labels = useBoardStore((s) => s.boards.find((b) => b.id === card.boardId)?.labels)
  const cardLabels = (labels ?? []).filter((l) => card.labelIds.includes(l.id))
  const faded = card.status === 'done' || card.status === 'dropped'
  const chips = card.links.filter((l) => l.kind === 'plan' || l.kind === 'pr' || l.kind === 'design')
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-[10px] border bg-surface-2 px-3 py-2.5 text-left outline-none focus-visible:border-accent',
        card.status === 'doing' ? 'border-accent/60' : 'border-border',
        overlay ? 'rotate-1 shadow-[0_10px_30px_rgba(0,0,0,0.18)]' : 'hover:border-fg-muted/40',
      )}
    >
      <span className={cn('text-base font-semibold', faded ? 'text-fg-secondary' : 'text-fg')}>
        {card.title}
      </span>
      {card.summary && !faded && (
        <span className="line-clamp-3 text-sm leading-[1.4] text-fg-secondary">{card.summary}</span>
      )}
      {cardLabels.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {cardLabels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </span>
      )}
      {(chips.length > 0 ||
        card.commentCount > 0 ||
        card.imageCount > 0 ||
        card.dueDate ||
        card.assignees.length > 0) && (
        <span className="flex items-center gap-2 pt-0.5 text-xs text-fg-secondary">
          {chips.slice(0, 3).map((link) => {
            const Icon = link.kind === 'pr' && link.state === 'done' ? GitMerge : LINK_ICON[link.kind]
            return (
              <span
                key={link.id}
                className={cn(
                  'flex min-w-0 items-center gap-1',
                  link.kind === 'pr' && link.state === 'done' && 'text-success',
                )}
              >
                <Icon size={11} className="shrink-0" aria-hidden />
                <span className="truncate">
                  {link.kind === 'pr'
                    ? (/^#\d+/.exec(link.label)?.[0] ?? t('boards.links.pr'))
                    : t(`boards.links.${link.kind}`)}
                </span>
              </span>
            )
          })}
          {card.imageCount > 0 && <Image size={11} aria-label={t('boards.hasImages')} />}
          {card.commentCount > 0 && (
            <span className="flex items-center gap-1">
              <MessageSquare size={11} aria-hidden />
              {card.commentCount}
            </span>
          )}
          {card.dueDate && <DueChip dueDate={card.dueDate} status={card.status} />}
          <span className="flex-1" />
          {card.assignees.length > 0 && <AssigneeStack assignees={card.assignees} />}
        </span>
      )}
    </button>
  )
}

function AddCard({ board }: { board: Board }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const addCard = useBoardStore((s) => s.addCard)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  const save = () => {
    const value = title.trim()
    if (!value) return setAdding(false)
    setTitle('')
    void addCard(workspaceId, board.id, { title: value }).catch(() => showToast('error'))
  }

  if (!adding)
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="focus-ring flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-fg-muted hover:bg-surface-2 hover:text-fg-secondary"
      >
        <Plus size={13} aria-hidden />
        {t('boards.addCard')}
      </button>
    )
  return (
    <input
      autoFocus
      value={title}
      maxLength={120}
      placeholder={t('boards.cardTitlePlaceholder')}
      aria-label={t('boards.cardTitlePlaceholder')}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') {
          setTitle('')
          setAdding(false)
        }
      }}
      className="h-9 rounded-[10px] border border-accent/50 bg-surface-2 px-3 text-base text-fg outline-none placeholder:text-fg-muted"
    />
  )
}
