import { describe, expect, it } from 'vitest'

import { removeById, upsertById } from './collections'

describe('collections', () => {
  const items = [
    { id: 'a', v: 1 },
    { id: 'b', v: 2 },
  ]

  it('replaces an item in place or appends it', () => {
    expect(upsertById(items, { id: 'a', v: 3 })).toEqual([
      { id: 'a', v: 3 },
      { id: 'b', v: 2 },
    ])
    expect(upsertById(items, { id: 'c', v: 4 }).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(items[0]?.v).toBe(1)
  })

  it('removes by id', () => {
    expect(removeById(items, 'a')).toEqual([{ id: 'b', v: 2 }])
    expect(removeById(items, 'x')).toEqual(items)
  })
})
