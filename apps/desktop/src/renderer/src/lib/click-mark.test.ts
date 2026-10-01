import { describe, expect, it } from 'vitest'

import { markerSize, markFromActivity, markFromToolArgs, markPercent } from './click-mark'

describe('activity click points', () => {
  it('reads click points from activity details', () => {
    expect(markFromActivity('click', '(639, 771)')).toEqual({ kind: 'click', x: 639, y: 771 })
    expect(markFromActivity('double_click', '(1, 2)')?.kind).toBe('double_click')
    expect(markFromActivity('drag', '(1, 2) → (30, 40)')).toEqual({
      kind: 'drag',
      x: 1,
      y: 2,
      toX: 30,
      toY: 40,
    })
    expect(markFromActivity('bash', 'ls')).toBeNull()
    expect(markFromActivity('click', '')).toBeNull()
    expect(markPercent(640, 400)).toEqual({ left: 50, top: 50 })
  })
})

describe('tool call click points', () => {
  it('reads single computer actions only', () => {
    expect(markFromToolArgs('computer', { action: 'click', x: 10.4, y: 20 })).toEqual({
      kind: 'click',
      x: 10,
      y: 20,
    })
    expect(
      markFromToolArgs('mcp__milibot__computer', { action: 'drag', x: 1, y: 2, to_x: 3, to_y: 4 })?.kind,
    ).toBe('drag')
    expect(markFromToolArgs('computer', { actions: [{ action: 'click', x: 1, y: 1 }] })).toBeNull()
    expect(markFromToolArgs('computer', { action: 'type', text: 'x' })).toBeNull()
    expect(markFromToolArgs('bash', { x: 1, y: 1, action: 'click' })).toBeNull()
  })
})

describe('click marker size', () => {
  it('scales with the rendered image and stays readable', () => {
    expect(markerSize(55)).toBe(12)
    expect(markerSize(140)).toBe(22)
    expect(markerSize(800)).toBe(32)
  })
})
