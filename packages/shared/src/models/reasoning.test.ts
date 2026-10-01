import { describe, expect, it } from 'vitest'

import { normalizeEffort, pickEffort } from './reasoning'

describe('pickEffort', () => {
  it('keeps an accepted level and sends as asked when the levels are unknown', () => {
    expect(pickEffort('high', ['low', 'high'])).toBe('high')
    expect(pickEffort('max', null)).toBe('max')
    expect(pickEffort(null, ['low'])).toBeNull()
  })

  it('moves to the nearest accepted level, up on a tie, and drops it when none is accepted', () => {
    expect(pickEffort('xhigh', ['low', 'medium', 'high'])).toBe('high')
    expect(pickEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('max')
    expect(pickEffort('low', ['high', 'max'])).toBe('high')
    expect(pickEffort('high', [])).toBeNull()
  })

  it('matches custom levels exactly and never ranks them', () => {
    expect(pickEffort('Turbo', ['low', 'turbo'])).toBe('turbo')
    expect(pickEffort('turbo', ['low', 'high'])).toBeNull()
    expect(pickEffort('high', ['minimal', 'turbo'])).toBeNull()
    expect(pickEffort('xhigh', ['minimal', 'high'])).toBe('high')
    expect(pickEffort('turbo', null)).toBe('turbo')
  })
})

describe('effort levels', () => {
  it('normalizes typed levels', () => {
    expect(normalizeEffort(' HIGH ')).toBe('high')
    expect(normalizeEffort('Ultra-Think')).toBe('Ultra-Think')
    expect(normalizeEffort('two words')).toBeNull()
    expect(normalizeEffort('')).toBeNull()
  })
})
