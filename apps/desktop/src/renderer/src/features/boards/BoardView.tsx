import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { type Board, BOARD_CARD_STATUSES, type BoardCard, columnCards } from '@milibot/shared'
import { useEffect, useState } from 'react'

import { dropPlace } from '@/features/boards/lib/boards'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'

import { CardTile, CollapsedColumn, Column } from './BoardColumn'
import { BoardHeader } from './BoardHeader'
import { CardDialog } from './card-dialog/CardDialog'
import { useBoardStore } from './store'

const NO_CARDS: BoardCard[] = []

const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args)
  return within.length ? within : closestCenter(args)
}

/** A board: its header and the four columns, cards dragged between them. */
export function BoardView({ board }: { board: Board }) {
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const cards = useBoardStore((s) => s.cards[board.id]) ?? NO_CARDS
  const loadCards = useBoardStore((s) => s.loadCards)
  const moveCard = useBoardStore((s) => s.moveCard)
  const [dragging, setDragging] = useState<string | null>(null)
  const [openCard, setOpenCard] = useState<string | null>(null)
  const [droppedOpen, setDroppedOpen] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  useEffect(() => {
    void loadCards(workspaceId, board.id).catch(() => showToast('error'))
  }, [loadCards, workspaceId, board.id, showToast])

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    const id = String(event.active.id)
    if (!event.over) return
    const place = dropPlace(cards, String(event.over.id))
    const card = cards.find((c) => c.id === id)
    if (!place || !card) return
    const from = columnCards(cards, card.status).findIndex((c) => c.id === id)
    if (place.status === card.status && place.index === from) return
    void moveCard(workspaceId, board.id, id, place.status, place.index).catch(() => showToast('error'))
  }

  const draggingCard = dragging ? cards.find((c) => c.id === dragging) : undefined

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={board.title}>
      <BoardHeader board={board} />
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={(e) => setDragging(String(e.active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="flex min-h-0 flex-1 gap-3 px-6 pt-1 pb-5">
          {BOARD_CARD_STATUSES.map((status) =>
            status === 'dropped' && !droppedOpen ? (
              <CollapsedColumn
                key={status}
                count={columnCards(cards, status).length}
                onOpen={() => setDroppedOpen(true)}
              />
            ) : (
              <Column
                key={status}
                board={board}
                status={status}
                cards={columnCards(cards, status)}
                onOpenCard={setOpenCard}
                {...(status === 'dropped' ? { onCollapse: () => setDroppedOpen(false) } : {})}
              />
            ),
          )}
        </div>
        <DragOverlay dropAnimation={null}>
          {draggingCard && <CardTile card={draggingCard} overlay />}
        </DragOverlay>
      </DndContext>
      {openCard && <CardDialog board={board} cardId={openCard} onClose={() => setOpenCard(null)} />}
    </section>
  )
}
