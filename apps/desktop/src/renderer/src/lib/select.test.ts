import { describe, expect, it } from 'vitest'

import { computeDropdownPosition, edgeOption, stepOption, typeaheadMatch } from './select'

// Portuguese on purpose: asserts accent-insensitive type-ahead.

const viewport = { width: 1200, height: 800 }

describe('computeDropdownPosition', () => {
  const anchor = { left: 100, top: 100, width: 200, height: 34 }

  it('opens under the trigger, left-aligned', () => {
    expect(computeDropdownPosition(anchor, { width: 240, height: 150 }, viewport)).toEqual({
      placement: 'bottom',
      left: 100,
      top: 138,
      maxHeight: 800 - 134 - 4 - 8,
    })
  })

  it('flips above when it does not fit below and there is more room above', () => {
    const low = { ...anchor, top: 700 }
    const position = computeDropdownPosition(low, { width: 240, height: 150 }, viewport)
    expect(position.placement).toBe('top')
    expect(position.top).toBe(700 - 4 - 150)
  })

  it('stays below and scrolls when below is roomier', () => {
    const high = { ...anchor, top: 300 }
    const position = computeDropdownPosition(high, { width: 240, height: 900 }, viewport)
    expect(position).toMatchObject({ placement: 'bottom', top: 338, maxHeight: 800 - 334 - 12 })
  })

  it('shrinks to the room above when flipped and clamps horizontally', () => {
    const corner = { left: 1100, top: 600, width: 90, height: 25 }
    const position = computeDropdownPosition(corner, { width: 300, height: 900 }, viewport)
    expect(position).toMatchObject({ placement: 'top', top: 8, maxHeight: 588, left: 1200 - 300 - 8 })
  })
})

describe('listbox navigation', () => {
  const options = [
    { label: 'Opus' },
    { label: 'Sonnet', disabled: true },
    { label: 'Haiku' },
    { label: 'Sem seção' },
    { label: 'Séries' },
  ]

  it('steps over disabled options and stops at the ends', () => {
    expect(stepOption(options, 0, 1)).toBe(2)
    expect(stepOption(options, 2, -1)).toBe(0)
    expect(stepOption(options, 0, -1)).toBe(0)
    expect(stepOption(options, 4, 1)).toBe(4)
    expect(stepOption(options, -1, 1)).toBe(0)
    expect(stepOption(options, -1, -1)).toBe(4)
    expect(edgeOption(options, 'last')).toBe(4)
    expect(edgeOption([{ label: 'x', disabled: true }], 'first')).toBe(-1)
  })

  it('matches type-ahead ignoring case and accents, cycling on a repeated letter', () => {
    expect(typeaheadMatch(options, 'h', 0)).toBe(2)
    expect(typeaheadMatch(options, 's', 0)).toBe(3)
    expect(typeaheadMatch(options, 'ss', 3)).toBe(4)
    expect(typeaheadMatch(options, 's', 4)).toBe(3)
    expect(typeaheadMatch(options, 'SER', 0)).toBe(4)
    expect(typeaheadMatch(options, 'sem s', 0)).toBe(3)
    expect(typeaheadMatch(options, 'son', 0)).toBe(-1)
    expect(typeaheadMatch(options, 'x', 0)).toBe(-1)
  })
})
