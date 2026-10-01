import type { BoardCardStatus, BoardStatus } from './boards'

export function isOpenCard(status: BoardCardStatus): boolean {
  return status === 'todo' || status === 'doing'
}

/** A local `YYYY-MM-DD`. */
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Past its due date and still open. */
export function isOverdue(
  item: { dueDate: string | null; status: BoardCardStatus | BoardStatus },
  today: string,
): boolean {
  if (!item.dueDate || item.dueDate >= today) return false
  return item.status === 'active' || (item.status !== 'done' && isOpenCard(item.status))
}

/** Cards of one column, in order. */
export function columnCards<T extends { status: BoardCardStatus; position: number; id: string }>(
  cards: readonly T[],
  status: BoardCardStatus,
): T[] {
  return cards
    .filter((c) => c.status === status)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
}

/**
 * The cards after moving `cardId` to `index` of the `status` column (clamped), with dense positions in both
 * columns. The daemon and the app (optimistic moves) use the same function.
 */
export function applyCardMove<T extends { status: BoardCardStatus; position: number; id: string }>(
  cards: readonly T[],
  cardId: string,
  status: BoardCardStatus,
  index: number,
): T[] {
  const card = cards.find((c) => c.id === cardId)
  if (!card) return [...cards]
  const target = columnCards(cards, status).filter((c) => c.id !== cardId)
  const at = Math.max(0, Math.min(index, target.length))
  target.splice(at, 0, { ...card, status })
  const positions = new Map<string, { status: BoardCardStatus; position: number }>()
  target.forEach((c, i) => positions.set(c.id, { status, position: i }))
  if (card.status !== status)
    columnCards(cards, card.status)
      .filter((c) => c.id !== cardId)
      .forEach((c, i) => positions.set(c.id, { status: card.status, position: i }))
  return cards.map((c) => {
    const next = positions.get(c.id)
    return next && (next.status !== c.status || next.position !== c.position) ? { ...c, ...next } : c
  })
}
