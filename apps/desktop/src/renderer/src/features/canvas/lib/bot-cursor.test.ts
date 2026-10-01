import { describe, expect, it } from 'vitest'

import {
  changedRegion,
  clampBox,
  driftSeed,
  easeInOutCubic,
  type ElementShot,
  glideMs,
  idleDrift,
  pointAlong,
  randomPointIn,
} from './bot-cursor'

const shot = (signature: string, x: number, y: number, width = 100, height = 20): ElementShot => ({
  signature,
  box: { x, y, width, height },
})

describe('changedRegion', () => {
  it('boxes the elements that are new or whose own content changed', () => {
    const before = [shot('DIV||', 0, 0, 400, 300), shot('H1||Hel', 20, 20), shot('P||Intro', 20, 60)]
    const after = [
      shot('DIV||', 0, 0, 400, 300),
      shot('H1||Hello', 20, 20, 120),
      shot('P||Intro', 20, 60),
      shot('BUTTON||Go', 20, 100, 80, 30),
    ]
    expect(changedRegion(before, after)).toEqual({ x: 20, y: 20, width: 120, height: 110 })
  })

  it('counts repeated elements and skips invisible ones', () => {
    const before = [shot('LI||x', 0, 0), shot('LI||x', 0, 20)]
    expect(changedRegion(before, [...before, shot('LI||x', 0, 40)])).toEqual({
      x: 0,
      y: 40,
      width: 100,
      height: 20,
    })
    expect(changedRegion(before, [...before, shot('SPAN||', 0, 0, 0, 0)])).toBeNull()
  })

  it('treats everything as new without a previous page', () => {
    expect(changedRegion(null, [shot('P||a', 10, 10), shot('P||b', 10, 50)])).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 60,
    })
  })
})

describe('cursor motion', () => {
  it('eases in and out and stays inside the box', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(0.5)).toBe(0.5)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1)
    expect(easeInOutCubic(2)).toBe(1)
    expect(glideMs(0)).toBe(300)
    expect(glideMs(5000)).toBe(500)
  })

  it('picks points inside the box, away from big boxes edges', () => {
    const box = { x: 100, y: 200, width: 400, height: 100 }
    expect(randomPointIn(box, () => 0)).toEqual({ x: 140, y: 220 })
    expect(randomPointIn(box, () => 1)).toEqual({ x: 460, y: 280 })
    expect(randomPointIn({ x: 0, y: 0, width: 10, height: 4 }, () => 0.5)).toEqual({ x: 5, y: 2 })
  })

  it('clamps a box to the frame', () => {
    const frame = { x: 0, y: 0, width: 390, height: 800 }
    expect(clampBox({ x: -20, y: 780, width: 100, height: 100 }, frame)).toEqual({
      x: 0,
      y: 780,
      width: 80,
      height: 20,
    })
    expect(clampBox({ x: 400, y: 0, width: 10, height: 10 }, frame)).toBeNull()
  })

  it('drifts gently and differently per bot', () => {
    for (let ms = 0; ms < 20_000; ms += 137) {
      const d = idleDrift(ms, 3)
      expect(Math.abs(d.x)).toBeLessThanOrEqual(8)
      expect(Math.abs(d.y)).toBeLessThanOrEqual(6.5)
    }
    expect(driftSeed('bot_a')).not.toBe(driftSeed('bot_b'))
  })
})

describe('pointAlong', () => {
  it('moves by distance along the polyline', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 30 },
    ]
    expect(pointAlong(line, 0)).toEqual({ x: 0, y: 0 })
    expect(pointAlong(line, 0.25)).toEqual({ x: 10, y: 0 })
    expect(pointAlong(line, 0.5)).toEqual({ x: 10, y: 10 })
    expect(pointAlong(line, 2)).toEqual({ x: 10, y: 30 })
    expect(pointAlong([], 0.5)).toBeNull()
  })
})
