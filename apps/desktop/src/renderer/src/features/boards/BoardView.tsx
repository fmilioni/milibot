import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  applyCardMove,
  type Board,
  BOARD_CARD_STATUSES,
  type BoardCard,
  type BoardCardStatus,
  columnCards,
  fullListIndex,
} from '@milibot/shared'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  activeFilterCount,
  COLUMN_PREFIX,
  dropPlace,
  filterCards,
  liveBotOf,
  NO_FILTERS,
} from '@/features/boards/lib/boards'
import { usePlanStore } from '@/features/plans/store'
import { useSessionStore } from '@/features/sessions/store'
import { copyWithToast, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { ConfirmDialog } from '@/ui/Confirm'

import { type CardAction, CardTile, CollapsedColumn, Column } from './BoardColumn'
import { BoardFilters } from './BoardFilters'
import { BoardHeader } from './BoardHeader'
import { CardDialog } from './card-dialog/CardDialog'
import { MoveCardDialog } from './MoveCardDialog'
import { useBoardStore } from './store'

const NO_CARDS: BoardCard[] = []
/** From this width of the columns' area, Dropped starts open (it folds into a strip below it). */
const WIDE_COLUMNS = 1100

// Cards first: the column under them is a drop target too, for its empty space.
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args)
  const cards = within.filter((c) => !String(c.id).startsWith(COLUMN_PREFIX))
  if (cards.length) return cards
  return within.length ? within : closestCenter(args)
}

/** A board: its header, filters and the four columns, cards dragged between them. */
export function BoardView({ board }: { board: Board }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const cards = useBoardStore((s) => s.cards[board.id]) ?? NO_CARDS
  const filters = useBoardStore((s) => s.filters[board.id]) ?? NO_FILTERS
  const setFilters = useBoardStore((s) => s.setFilters)
  const loadCards = useBoardStore((s) => s.loadCards)
  const moveCard = useBoardStore((s) => s.moveCard)
  const deleteCard = useBoardStore((s) => s.deleteCard)
  const sessions = useSessionStore((s) => s.sessions)
  const plans = usePlanStore((s) => s.running)
  const [dragging, setDragging] = useState<string | null>(null)
  // The cards while a drag crosses columns: the dragged one already sits where it would land.
  const [preview, setPreview] = useState<BoardCard[] | null>(null)
  const [openCard, setOpenCard] = useState<string | null>(null)
  const [moving, setMoving] = useState<BoardCard | null>(null)
  const [deleting, setDeleting] = useState<BoardCard | null>(null)
  const [droppedChoice, setDroppedChoice] = useState<boolean | null>(null)
  const [wide, setWide] = useState(false)
  const area = useRef<HTMLDivElement>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  useEffect(() => {
    void loadCards(workspaceId, board.id).catch(() => showToast('error'))
  }, [loadCards, workspaceId, board.id, showToast])

  useEffect(() => {
    const el = area.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWide((entry?.contentRect.width ?? 0) >= WIDE_COLUMNS))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const shown = preview ?? cards
  const filtered = activeFilterCount(filters) > 0
  const visible = useMemo(() => filterCards(shown, filters, board.labels), [shown, filters, board.labels])
  const live = useMemo(() => {
    const out: Record<string, string> = {}
    for (const card of cards) {
      const bot = liveBotOf(card, sessions, plans)
      if (bot) out[card.id] = bot
    }
    return out
  }, [cards, sessions, plans])
  const droppedOpen = droppedChoice ?? wide

  /** Where the dragged card lands among the cards shown, as an index into its whole column. */
  const landing = (id: string, overId: string): { status: BoardCardStatus; index: number } | null => {
    const place = dropPlace(visible, overId)
    if (!place) return null
    const index = fullListIndex(
      columnCards(shown, place.status).map((c) => c.id),
      columnCards(visible, place.status).map((c) => c.id),
      id,
      place.index,
    )
    return { status: place.status, index }
  }

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return
    const id = String(active.id)
    const card = shown.find((c) => c.id === id)
    const place = landing(id, String(over.id))
    if (!card || !place || place.status === card.status) return
    setPreview(applyCardMove(shown, id, place.status, place.index))
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id)
    const place = over ? landing(id, String(over.id)) : null
    setDragging(null)
    setPreview(null)
    const card = cards.find((c) => c.id === id)
    if (!place || !card) return
    const from = columnCards(cards, card.status).findIndex((c) => c.id === id)
    if (place.status === card.status && place.index === from) return
    void moveCard(workspaceId, board.id, id, place.status, place.index).catch(() => showToast('error'))
  }

  const onCard = (card: BoardCard, action: CardAction) => {
    if (action === 'open') setOpenCard(card.id)
    else if (action === 'copy-id') copyWithToast(card.id, 'idCopied')
    else if (action === 'move') setMoving(card)
    else setDeleting(card)
  }

  const draggingCard = dragging ? shown.find((c) => c.id === dragging) : undefined
  const draggingFrom = dragging ? cards.find((c) => c.id === dragging)?.status : undefined
  const draggingAt = draggingCard?.status

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={board.title}>
      <BoardHeader board={board} />
      <div className="shrink-0 px-5 pb-3">
        <BoardFilters board={board} filters={filters} onChange={(next) => setFilters(board.id, next)} />
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={(e) => setDragging(String(e.active.id))}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDragging(null)
          setPreview(null)
        }}
      >
        <div ref={area} className="flex min-h-0 flex-1 gap-4 overflow-x-auto px-5 pb-4">
          {BOARD_CARD_STATUSES.map((status) =>
            status === 'dropped' && !droppedOpen ? (
              <CollapsedColumn
                key={status}
                count={columnCards(cards, status).length}
                onOpen={() => setDroppedChoice(true)}
              />
            ) : (
              <Column
                key={status}
                board={board}
                status={status}
                cards={columnCards(visible, status)}
                total={columnCards(shown, status).length}
                filtered={filtered}
                dropTarget={draggingAt === status && draggingFrom !== status}
                live={live}
                onCard={onCard}
                {...(status === 'dropped' ? { onCollapse: () => setDroppedChoice(false) } : {})}
              />
            ),
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {draggingCard && <CardTile card={draggingCard} liveBot={live[draggingCard.id] ?? null} overlay />}
        </DragOverlay>
      </DndContext>
      {openCard && (
        <CardDialog
          board={board}
          cardId={openCard}
          liveBot={live[openCard] ?? null}
          onClose={() => setOpenCard(null)}
          onMove={(card) => setMoving(card)}
        />
      )}
      {moving && (
        <MoveCardDialog
          card={moving}
          onClose={() => setMoving(null)}
          onMoved={() => setOpenCard((open) => (open === moving.id ? null : open))}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('boards.card.deleteTitle', { title: deleting.title })}
          description={t('boards.card.deleteDescription')}
          confirmLabel={t('boards.delete.confirm')}
          onConfirm={() => deleteCard(workspaceId, board.id, deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  )
}
