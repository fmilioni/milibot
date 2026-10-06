import { describe, expect, it } from 'vitest'

import type { BoardCardStatus } from './boards'
import { applyCardMove, columnCards, fullListIndex, isOpenCard, isOverdue } from './cards'

const card = (id: string, status: BoardCardStatus, position: number) => ({ id, status, position })

const columns = (cards: ReturnType<typeof card>[]) =>
  Object.fromEntries(
    (['todo', 'doing', 'done', 'dropped'] as const).map((s) => [s, columnCards(cards, s).map((c) => c.id)]),
  )

describe('boards', () => {
  const cards = [card('a', 'todo', 0), card('b', 'todo', 1), card('c', 'todo', 2), card('d', 'doing', 0)]

  it('moves a card to another column and renumbers both', () => {
    const moved = applyCardMove(cards, 'b', 'doing', 0)
    expect(columns(moved)).toEqual({ todo: ['a', 'c'], doing: ['b', 'd'], done: [], dropped: [] })
    expect(moved.find((c) => c.id === 'c')).toMatchObject({ position: 1 })
    expect(moved.find((c) => c.id === 'd')).toMatchObject({ position: 1 })
  })

  it('reorders inside a column and clamps the index', () => {
    expect(columns(applyCardMove(cards, 'a', 'todo', 99)).todo).toEqual(['b', 'c', 'a'])
    expect(columns(applyCardMove(cards, 'c', 'todo', 0)).todo).toEqual(['c', 'a', 'b'])
  })

  it('keeps unchanged cards as the same objects', () => {
    const moved = applyCardMove(cards, 'c', 'done', 0)
    expect(moved[0]).toBe(cards[0])
    expect(moved[3]).toBe(cards[3])
  })

  it('is overdue only while open and past the date', () => {
    expect(isOverdue({ dueDate: '2026-09-28', status: 'todo' }, '2026-09-29')).toBe(true)
    expect(isOverdue({ dueDate: '2026-09-29', status: 'todo' }, '2026-09-29')).toBe(false)
    expect(isOverdue({ dueDate: '2026-09-01', status: 'done' }, '2026-09-29')).toBe(false)
    expect(isOverdue({ dueDate: '2026-09-01', status: 'active' }, '2026-09-29')).toBe(true)
    expect(isOverdue({ dueDate: null, status: 'doing' }, '2026-09-29')).toBe(false)
  })

  it('counts todo and doing cards as open', () => {
    expect((['todo', 'doing', 'done', 'dropped'] as const).filter(isOpenCard)).toEqual(['todo', 'doing'])
    expect(isOverdue({ dueDate: '2026-09-01', status: 'dropped' }, '2026-09-29')).toBe(false)
  })
})

describe('fullListIndex', () => {
  const full = ['a', 'b', 'c', 'd', 'e']

  it('puts the item before the one it lands on in the filtered list', () => {
    expect(fullListIndex(full, ['b', 'd', 'e'], 'a', 1)).toBe(2)
    expect(fullListIndex(full, ['a', 'c', 'e'], 'e', 0)).toBe(0)
    expect(fullListIndex(full, ['a', 'c', 'e'], 'a', 1)).toBe(3)
  })

  it('goes right after the last visible item when dropped at the end', () => {
    expect(fullListIndex(full, ['a', 'c'], 'e', 2)).toBe(3)
    expect(fullListIndex(full, ['b', 'd'], 'a', 2)).toBe(3)
  })

  it('goes to the end of an empty filtered list', () => {
    expect(fullListIndex(full, [], 'x', 0)).toBe(5)
    expect(fullListIndex([], [], 'x', 0)).toBe(0)
  })

  it('matches applyCardMove on a filtered column', () => {
    const column = full.map((id, i) => card(id, 'todo', i))
    const index = fullListIndex(full, ['b', 'd'], 'e', 1)
    expect(columnCards(applyCardMove(column, 'e', 'todo', index), 'todo').map((c) => c.id)).toEqual([
      'a',
      'b',
      'c',
      'e',
      'd',
    ])
  })
})
