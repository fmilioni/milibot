import { describe, expect, it } from 'vitest'

import { firstOverlap, nearestFreeSpot, rectsOverlap } from './placement'

const frame = (id: string, x: number, y: number, width: number, height: number) => ({
  id,
  x,
  y,
  width,
  height,
})

describe('frame placement', () => {
  it('finds the nearest free spot for a dropped frame', () => {
    const frames = [frame('a', 0, 0, 400, 400), frame('moving', 1000, 0, 300, 300)]
    expect(nearestFreeSpot({ x: 900, y: 900, width: 300, height: 300 }, frames, 'moving')).toEqual({
      x: 900,
      y: 900,
    })
    const spot = nearestFreeSpot({ x: 100, y: 50, width: 300, height: 300 }, frames, 'moving')
    expect(rectsOverlap({ ...spot, width: 300, height: 300 }, frames[0]!)).toBe(false)
    expect(spot).toEqual({ x: 440, y: 50 })
  })

  it('ignores the frame being moved when looking for overlaps', () => {
    const frames = [frame('a', 0, 0, 100, 100), frame('b', 50, 50, 100, 100)]
    expect(firstOverlap({ x: 60, y: 60, width: 10, height: 10 }, frames, 'b')?.id).toBe('a')
    expect(firstOverlap({ x: 120, y: 120, width: 10, height: 10 }, frames, 'b')).toBeNull()
    expect(rectsOverlap(frame('x', 0, 0, 10, 10), frame('y', 10, 0, 10, 10))).toBe(false)
  })
})
