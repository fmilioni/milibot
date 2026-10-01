import { describe, expect, it } from 'vitest'

import {
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  stepZoom,
  toScreen,
  toWorld,
  wheelZoomFactor,
  zoomAt,
  zoomPercent,
} from './viewport'

describe('viewport math', () => {
  it('maps world and screen points both ways', () => {
    const v = { x: 100, y: 50, zoom: 0.5 }
    expect(toScreen(v, { x: 200, y: 100 })).toEqual({ x: 200, y: 100 })
    expect(toWorld(v, { x: 200, y: 100 })).toEqual({ x: 200, y: 100 })
    expect(toWorld(v, toScreen(v, { x: -30, y: 812 }))).toEqual({ x: -30, y: 812 })
  })

  it('zooms around the cursor: the point under it stays put', () => {
    const v = { x: 40, y: -20, zoom: 0.4 }
    const anchor = { x: 300, y: 220 }
    const before = toWorld(v, anchor)
    const next = zoomAt(v, 1.2, anchor)
    expect(next.zoom).toBe(1.2)
    const after = toWorld(next, anchor)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('clamps the zoom and steps through the presets', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM)
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 99, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM)
    expect(stepZoom(0.4, 1)).toBe(0.5)
    expect(stepZoom(0.4, -1)).toBe(0.33)
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
    expect(zoomPercent(0.4)).toBe(40)
  })

  it('turns wheel deltas into zoom factors (up zooms in, clamped)', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1)
    expect(wheelZoomFactor(10)).toBeLessThan(1)
    expect(wheelZoomFactor(10000)).toBeCloseTo(Math.exp(-0.25))
    expect(wheelZoomFactor(1, 1)).toBeCloseTo(wheelZoomFactor(16))
  })
})
