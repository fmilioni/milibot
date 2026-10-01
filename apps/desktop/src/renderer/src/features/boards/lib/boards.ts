import {
  type Board,
  BOARD_CARD_STATUSES,
  type BoardCardStatus,
  type BoardCounts,
  columnCards,
} from '@milibot/shared'

import type { Tone } from '@/lib/tone'

export type BoardFilter = 'active' | 'done' | 'archived'

export const CARD_TONE: Record<BoardCardStatus, Tone> = {
  todo: 'muted',
  doing: 'accent',
  done: 'success',
  dropped: 'danger',
}

export const COLUMN_PREFIX = 'column:'

export function boardsIn(boards: readonly Board[], filter: BoardFilter): Board[] {
  return boards.filter((b) =>
    filter === 'archived' ? b.archivedAt !== null : b.archivedAt === null && b.status === filter,
  )
}

/** Done cards over the cards that count (dropped ones do not). */
export function boardProgress(counts: BoardCounts): { done: number; total: number } {
  return { done: counts.done, total: counts.todo + counts.doing + counts.done }
}

/**
 * Where a dragged card lands: the column and index of the card it is over (its place in that column as it is
 * now), or the end of a column it is over.
 */
export function dropPlace(
  cards: readonly { id: string; status: BoardCardStatus; position: number }[],
  overId: string,
): { status: BoardCardStatus; index: number } | null {
  if (overId.startsWith(COLUMN_PREFIX)) {
    const status = overId.slice(COLUMN_PREFIX.length) as BoardCardStatus
    if (!BOARD_CARD_STATUSES.includes(status)) return null
    return { status, index: columnCards(cards, status).length }
  }
  const over = cards.find((c) => c.id === overId)
  if (!over) return null
  return { status: over.status, index: columnCards(cards, over.status).findIndex((c) => c.id === overId) }
}

/** `text` with `insert` at the caret (on its own line when the caret is mid-line). */
export function insertAtCaret(text: string, caret: number, insert: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n' : ''
  const piece = `${lead}${insert}${trail}`
  return { text: before + piece + after, caret: at + piece.length }
}
