import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type Board, type BoardCard, type BoardCardStatus, isOverdue, localDate } from '@milibot/shared'
import {
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  CircleCheck,
  CircleSlash,
  Copy,
  FolderInput,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hammer,
  Image,
  Inbox,
  ListChecks,
  MessageSquare,
  PenTool,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CARD_TONE, COLUMN_PREFIX, doingLoad, prChip } from '@/features/boards/lib/boards'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatDueDate } from '@/lib/calendar'
import { cn } from '@/lib/cn'
import { TONE_FILL } from '@/lib/tone'
import { MoreMenu } from '@/ui/MoreMenu'
import { Tooltip } from '@/ui/Tooltip'

import { AssigneeStack, LabelChip } from './CardPeople'
import { useBoardStore } from './store'

export type CardAction = 'open' | 'copy-id' | 'move' | 'delete'

const EMPTY_ICON: Record<BoardCardStatus, typeof Inbox> = {
  todo: Inbox,
  doing: Hammer,
  done: CircleCheck,
  dropped: CircleSlash,
}

/** The 2px stripe on top of a column, in its status color. */
function Stripe({ status }: { status: BoardCardStatus }) {
  return <span className={`h-[2px] shrink-0 rounded-full ${TONE_FILL[CARD_TONE[status]]}`} aria-hidden />
}

function CountBadge({
  children,
  warn = false,
  label,
}: {
  children: ReactNode
  warn?: boolean
  label?: string
}) {
  return (
    <span
      aria-label={label}
      className={cn(
        'flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-2xs font-semibold tabular-nums',
        warn ? 'bg-warning-tint text-warning-strong' : 'bg-surface-3 text-fg-secondary',
      )}
    >
      {warn && <TriangleAlert size={10} className="mr-0.5 shrink-0" aria-hidden />}
      {children}
    </span>
  )
}

export function Column({
  board,
  status,
  cards,
  total,
  filtered,
  dropTarget,
  live,
  onCard,
  onCollapse,
}: {
  board: Board
  status: BoardCardStatus
  /** The cards shown (after the filters). */
  cards: BoardCard[]
  /** Every card of the column (the counter). */
  total: number
  filtered: boolean
  /** A card from another column is over this one. */
  dropTarget: boolean
  live: Record<string, string>
  onCard: (card: BoardCard, action: CardAction) => void
  onCollapse?: () => void
}) {
  const { t } = useTranslation()
  const { setNodeRef } = useDroppable({ id: `${COLUMN_PREFIX}${status}` })
  const [adding, setAdding] = useState(false)
  const load = status === 'doing' ? doingLoad(total, board.doingLimit) : null
  const canAdd = status === 'todo' && board.archivedAt === null
  const EmptyIcon = EMPTY_ICON[status]
  return (
    <section
      ref={setNodeRef}
      aria-label={t(`boards.columns.${status}`)}
      className="flex min-w-[200px] flex-1 flex-col"
    >
      <Stripe status={status} />
      <header className="flex h-[34px] shrink-0 items-center gap-2 px-0.5">
        <h3 className="truncate text-base font-semibold text-fg">{t(`boards.columns.${status}`)}</h3>
        {load ? (
          <Tooltip content={board.doingLimit ? t('boards.doingLimit', { limit: board.doingLimit }) : null}>
            <CountBadge warn={load.over}>
              {load.text}
              {load.over && <span className="sr-only">{t('boards.doingLimitReached')}</span>}
            </CountBadge>
          </Tooltip>
        ) : (
          <CountBadge>{total}</CountBadge>
        )}
        <span className="flex-1" />
        {dropTarget && (
          <span className="text-sm font-semibold text-accent-strong">{t('boards.dropHere')}</span>
        )}
        {canAdd && !dropTarget && (
          <Tooltip content={t('boards.addCard')}>
            <button
              type="button"
              aria-label={t('boards.addCard')}
              onClick={() => setAdding(true)}
              className={cn(
                'focus-ring hit flex size-6 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 hover:text-fg',
                adding && 'bg-surface-3 text-fg',
              )}
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        )}
        {onCollapse && (
          <Tooltip content={t('boards.collapse')}>
            <button
              type="button"
              aria-label={t('boards.collapse')}
              onClick={onCollapse}
              className="focus-ring hit flex size-6 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 hover:text-fg"
            >
              <ChevronsRight size={14} />
            </button>
          </Tooltip>
        )}
      </header>
      <div
        className={cn(
          'scroll-slim -mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-card border px-1 pt-1 pb-3',
          dropTarget ? 'border-accent/50 bg-accent-soft' : 'border-transparent',
        )}
      >
        {adding && <NewCard board={board} onDone={() => setAdding(false)} />}
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} liveBot={live[card.id] ?? null} onCard={onCard} />
          ))}
        </SortableContext>
        {cards.length === 0 &&
          !adding &&
          (filtered && total > 0 ? (
            <p className="px-1 py-3 text-sm text-fg-secondary">{t('boards.noMatches')}</p>
          ) : (
            !dropTarget && (
              <div className="flex flex-col items-center gap-1.5 rounded-card border border-dashed border-fg-muted/60 px-4 py-5 text-center">
                <span className="mb-1 flex size-8 items-center justify-center rounded-full bg-surface-3 text-fg-secondary">
                  <EmptyIcon size={16} aria-hidden />
                </span>
                <span className="text-base font-semibold text-fg">
                  {t(`boards.emptyColumn.${status}.title`)}
                </span>
                <span className="text-sm text-fg-secondary">{t(`boards.emptyColumn.${status}.hint`)}</span>
              </div>
            )
          ))}
      </div>
    </section>
  )
}

/** Dropped, folded into a vertical strip that still takes drops. */
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
        'focus-ring flex w-9 shrink-0 flex-col items-center gap-2 rounded-b-card pb-3 hover:bg-surface-2',
        isOver && 'bg-danger-tint',
      )}
    >
      <span className={`h-[2px] w-full shrink-0 rounded-full ${TONE_FILL.danger}`} aria-hidden />
      <span className="-mt-2 flex h-[34px] items-center">
        <CountBadge>{count}</CountBadge>
      </span>
      <span className="text-base font-semibold text-fg-secondary [writing-mode:vertical-rl]">
        {t('boards.columns.dropped')}
      </span>
      <ChevronsLeft size={14} className="mt-auto text-fg-secondary" aria-hidden />
    </button>
  )
}

function SortableCard({
  card,
  liveBot,
  onCard,
}: {
  card: BoardCard
  liveBot: string | null
  onCard: (card: BoardCard, action: CardAction) => void
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
      className={cn(isDragging && 'rounded-card border-2 border-dashed border-accent/70')}
    >
      <div className={cn(isDragging && 'invisible')}>
        <CardTile card={card} liveBot={liveBot} onCard={onCard} />
      </div>
    </div>
  )
}

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

/** A card on the board: title, summary, labels, indicators in a fixed order and who is on it. */
export function CardTile({
  card,
  liveBot = null,
  onCard,
  overlay = false,
}: {
  card: BoardCard
  liveBot?: string | null
  onCard?: (card: BoardCard, action: CardAction) => void
  overlay?: boolean
}) {
  const { t, i18n } = useTranslation()
  const labels = useBoardStore((s) => s.boards.find((b) => b.id === card.boardId)?.labels)
  const liveName = useAppStore((s) => (liveBot ? s.bots[liveBot]?.name : undefined))
  const today = localDate(useNow(60_000))
  const cardLabels = (labels ?? []).filter((l) => card.labelIds.includes(l.id))
  const faded = card.status === 'done' || card.status === 'dropped'
  const plan = card.links.find((l) => l.kind === 'plan')
  const prs = card.links.filter((l) => l.kind === 'pr')
  const design = card.links.find((l) => l.kind === 'design')
  const late = card.dueDate ? isOverdue({ dueDate: card.dueDate, status: card.status }, today) : false
  const titleId = `card-title-${card.id}`
  const hasIndicators =
    plan ||
    prs.length ||
    design ||
    card.commentCount ||
    card.dueDate ||
    card.imageCount ||
    card.assignees.length
  return (
    <article
      onClick={() => onCard?.(card, 'open')}
      className={cn(
        'group relative flex w-full cursor-pointer flex-col gap-1.5 rounded-card border border-border bg-surface-2 px-3 py-2.5 text-left',
        'has-[.card-open:focus-visible]:outline-2 has-[.card-open:focus-visible]:outline-offset-2 has-[.card-open:focus-visible]:outline-accent',
        overlay
          ? 'rotate-2 cursor-grabbing border-accent/60 shadow-[0_14px_36px_rgba(0,0,0,0.28)]'
          : 'hover:border-fg-muted/70 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]',
      )}
    >
      {/* Covers the card for the keyboard and screen readers; a click anywhere on the card opens it too. */}
      <button
        type="button"
        aria-labelledby={titleId}
        tabIndex={overlay ? -1 : 0}
        className="card-open absolute inset-0 rounded-card outline-none"
      />
      {liveBot && (
        <span className="relative flex items-center gap-1.5 text-xs font-semibold text-success-strong">
          <span
            className="size-2 animate-pulse rounded-full bg-success motion-reduce:animate-none"
            aria-hidden
          />
          {t('boards.live', { name: liveName ?? '…' })}
        </span>
      )}
      <span
        id={titleId}
        className={cn(
          'relative line-clamp-3 text-base leading-[1.4] font-semibold break-words',
          faded ? 'text-fg-secondary' : 'text-fg',
        )}
      >
        {card.title}
      </span>
      {card.summary && !faded && (
        <span className="relative line-clamp-2 text-sm leading-[1.45] text-fg-secondary">{card.summary}</span>
      )}
      {cardLabels.length > 0 && (
        <span className="relative flex flex-wrap gap-1">
          {cardLabels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </span>
      )}
      {hasIndicators ? (
        <span className="relative flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-secondary">
          {plan && (
            <Indicator tip={t('boards.indicators.plan', { label: plan.label })}>
              <ListChecks size={14} aria-hidden />
            </Indicator>
          )}
          {prs.map((link) => {
            const chip = prChip(link)
            const Icon =
              chip.state === 'done'
                ? GitMerge
                : chip.state === 'failed'
                  ? GitPullRequestClosed
                  : GitPullRequest
            return (
              <Indicator key={link.id} tip={t('boards.indicators.pr', { label: link.label })}>
                <span
                  className={cn(
                    'flex h-[18px] items-center gap-1 rounded-[5px] px-[5px] text-xs font-semibold',
                    chip.state === 'done'
                      ? 'bg-success-soft text-success-strong'
                      : chip.state === 'failed'
                        ? 'bg-danger-tint text-danger-strong'
                        : 'bg-accent-soft text-accent-strong',
                  )}
                >
                  <Icon size={12} aria-hidden />
                  {[chip.number ?? t('boards.links.pr'), chip.state && t(`boards.card.prState.${chip.state}`)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </Indicator>
            )
          })}
          {design && (
            <Indicator tip={t('boards.indicators.design', { label: design.label })}>
              <PenTool size={14} aria-hidden />
            </Indicator>
          )}
          {card.commentCount > 0 && (
            <Indicator tip={t('boards.indicators.comments', { count: card.commentCount })}>
              <span className="flex items-center gap-1">
                <MessageSquare size={14} aria-hidden />
                {card.commentCount}
              </span>
            </Indicator>
          )}
          {card.dueDate && (
            <Indicator
              tip={
                late
                  ? t('boards.indicators.overdue', {
                      date: formatDueDate(card.dueDate, i18n.language, today),
                    })
                  : t('boards.indicators.due', { date: formatDueDate(card.dueDate, i18n.language, today) })
              }
            >
              <span
                className={cn(
                  'flex h-[18px] items-center gap-1 rounded-[5px] px-[5px] text-xs font-semibold',
                  late ? 'bg-danger-tint text-danger-strong' : 'bg-surface-3 text-fg-secondary',
                )}
              >
                <CalendarDays size={12} aria-hidden />
                {formatDueDate(card.dueDate, i18n.language, today)}
              </span>
            </Indicator>
          )}
          {card.imageCount > 0 && (
            <Indicator tip={t('boards.hasImages')}>
              <Image size={14} aria-hidden />
            </Indicator>
          )}
          {card.assignees.length > 0 && (
            <span className="ml-auto">
              <AssigneeStack assignees={card.assignees} size={20} max={3} />
            </span>
          )}
        </span>
      ) : null}
      {onCard && !overlay && (
        <span
          className="absolute top-2 right-2 rounded-md bg-surface-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100"
          onClick={stop}
          onPointerDown={stop}
          onKeyDown={stop}
        >
          <MoreMenu
            className="hit"
            label={t('boards.card.more', { title: card.title })}
            width={210}
            entries={[
              {
                key: 'copy-id',
                label: t('boards.card.copyId'),
                icon: <Copy size={14} />,
                onSelect: () => onCard(card, 'copy-id'),
              },
              {
                key: 'move',
                label: t('boards.card.moveTo'),
                icon: <FolderInput size={14} />,
                onSelect: () => onCard(card, 'move'),
              },
              { type: 'separator', key: 'sep' },
              {
                key: 'delete',
                label: t('boards.card.delete'),
                icon: <Trash2 size={14} />,
                danger: true,
                onSelect: () => onCard(card, 'delete'),
              },
            ]}
          />
        </span>
      )}
    </article>
  )
}

/** An indicator with its tooltip; hovering it never starts a drag or opens the card by itself. */
function Indicator({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <Tooltip content={tip}>
      <span className="flex items-center" aria-label={tip} role="img">
        {children}
      </span>
    </Tooltip>
  )
}

/** The new card's title, typed at the top of To do. */
function NewCard({ board, onDone }: { board: Board; onDone: () => void }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const addCard = useBoardStore((s) => s.addCard)
  const [title, setTitle] = useState('')

  const save = (keepOpen: boolean) => {
    const value = title.trim()
    if (!value) return onDone()
    setTitle('')
    void addCard(workspaceId, board.id, { title: value, index: 0 }).catch(() => showToast('error'))
    if (!keepOpen) onDone()
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        autoFocus
        value={title}
        maxLength={120}
        placeholder={t('boards.cardTitlePlaceholder')}
        aria-label={t('boards.cardTitlePlaceholder')}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => save(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save(true)
          if (e.key === 'Escape') {
            setTitle('')
            onDone()
          }
        }}
        className="h-9 rounded-card border-2 border-accent bg-surface-2 px-3 text-base text-fg outline-none placeholder:text-fg-secondary"
      />
      <span className="px-1 text-xs text-fg-secondary">{t('boards.newCardHint')}</span>
    </div>
  )
}
