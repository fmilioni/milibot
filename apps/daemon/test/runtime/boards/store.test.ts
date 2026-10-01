import { describe, expect, it } from 'vitest'

import { boardStatusOf, countCards } from '../../../src/runtime/boards/store'

const card = (status: 'todo' | 'doing' | 'done' | 'dropped') => ({ status })

describe('board status', () => {
  it('is done once every card is done or dropped', () => {
    expect(boardStatusOf(countCards([]))).toBe('active')
    expect(boardStatusOf(countCards([card('done'), card('dropped')]))).toBe('done')
    expect(boardStatusOf(countCards([card('done'), card('doing')]))).toBe('active')
    expect(countCards([card('todo'), card('todo'), card('done')])).toEqual({
      todo: 2,
      doing: 0,
      done: 1,
      dropped: 0,
    })
  })
})
