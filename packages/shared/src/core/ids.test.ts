import { describe, expect, it } from 'vitest'

import { newId, ulid } from './ids'

describe('ids', () => {
  it('generates prefixed, lowercase ids', () => {
    expect(newId('bot')).toMatch(/^bot_[0-9a-z]{26}$/)
    expect(newId('workspace')).toMatch(/^ws_/)
  })

  it('is monotonic within the same millisecond', () => {
    const ids = Array.from({ length: 500 }, () => ulid(1_700_000_000_000))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
