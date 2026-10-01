import { rectsOverlap } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { autoPlace, FRAME_GAP, ROW_WIDTH } from '../../../src/runtime/design/placement'

describe('frame placement', () => {
  const frame = (id: string, x: number, y: number, width = 1440, height = 900) => ({
    id,
    x,
    y,
    width,
    height,
  })

  it('puts new frames to the right of the last one and wraps into a new row', () => {
    expect(autoPlace([], { width: 390, height: 844 })).toEqual({ x: 0, y: 0, width: 390, height: 844 })
    const one = [frame('a', 0, 0)]
    expect(autoPlace(one, { width: 1440, height: 900 })).toMatchObject({ x: 1440 + FRAME_GAP, y: 0 })
    const row = [frame('a', 0, 0), frame('b', 1520, 0), frame('c', 3040, 0)]
    const next = autoPlace(row, { width: 1440, height: 900 })
    expect(next.x + next.width > ROW_WIDTH).toBe(false)
    expect(next).toMatchObject({ x: 0, y: 900 + FRAME_GAP })
  })

  it('never overlaps an existing frame', () => {
    const frames = [frame('a', 0, 0, 400, 400), frame('b', 480, 0, 400, 400), frame('c', 960, 0, 400, 2000)]
    const placed = autoPlace([frames[0]!, frames[2]!, frames[1]!], { width: 400, height: 400 })
    for (const f of frames) expect(rectsOverlap({ ...placed }, f)).toBe(false)
  })
})
