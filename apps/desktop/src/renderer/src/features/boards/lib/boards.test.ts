import { applyCardMove, type Board, type BoardCardStatus, columnCards } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { boardsIn, dropPlace, insertAtCaret } from './boards'

const card = (id: string, status: BoardCardStatus, position: number) => ({ id, status, position })

describe('boards view', () => {
  const cards = [card('a', 'todo', 0), card('b', 'todo', 1), card('c', 'todo', 2), card('d', 'doing', 0)]

  it('drops on a card at its place, on a column at its end', () => {
    expect(dropPlace(cards, 'b')).toEqual({ status: 'todo', index: 1 })
    expect(dropPlace(cards, 'column:doing')).toEqual({ status: 'doing', index: 1 })
    expect(dropPlace(cards, 'column:done')).toEqual({ status: 'done', index: 0 })
    expect(dropPlace(cards, 'nope')).toBeNull()
  })

  it('moves a card down its column like the list the user sees', () => {
    const place = dropPlace(cards, 'c')!
    const moved = applyCardMove(cards, 'a', place.status, place.index)
    expect(columnCards(moved, 'todo').map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('splits boards into active, done and archived', () => {
    const board = (id: string, status: 'active' | 'done', archived: boolean) =>
      ({
        id,
        status,
        archivedAt: archived ? 1 : null,
        counts: { todo: 0, doing: 0, done: 0, dropped: 0 },
      }) as Board
    const boards = [board('a', 'active', false), board('b', 'done', false), board('c', 'done', true)]
    expect(boardsIn(boards, 'active').map((b) => b.id)).toEqual(['a'])
    expect(boardsIn(boards, 'done').map((b) => b.id)).toEqual(['b'])
    expect(boardsIn(boards, 'archived').map((b) => b.id)).toEqual(['c'])
  })

  it('puts an image on its own line at the caret', () => {
    expect(insertAtCaret('ab', 1, '![x](asset:1)')).toEqual({ text: 'a\n![x](asset:1)\nb', caret: 16 })
    expect(insertAtCaret('', 0, 'img')).toEqual({ text: 'img', caret: 3 })
    expect(insertAtCaret('line\n', 5, 'img')).toEqual({ text: 'line\nimg', caret: 8 })
  })
})
