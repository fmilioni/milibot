import type { DesignFrame, DesignToken } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { fitViewport, toScreen } from '@/lib/viewport'

import {
  AUTO_HEIGHT_GUESS,
  boundsOf,
  centerOn,
  draftHeight,
  dropSpot,
  fitAll,
  FRAME_LABEL_HEIGHT,
  frameContextPrefix,
  frameHeight,
  frameRects,
  hitTest,
  isOffscreen,
  resolveTheme,
  revisionKind,
  snapPosition,
  splitFrameContext,
  themeBackground,
  themeKey,
  visibleFrameIds,
} from './canvas'

const frame = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number | null,
  extra = {},
): DesignFrame => ({
  id,
  designId: 'des_1',
  name: id,
  x,
  y,
  width,
  height,
  measuredHeight: null,
  theme: null,
  position: 0,
  updatedAt: 1,
  ...extra,
})

const token = (
  name: string,
  type: DesignToken['type'],
  value: string | number | null,
  values = {},
): DesignToken => ({
  name,
  type,
  value,
  values,
})

describe('viewport math', () => {
  it('fits everything centered with padding, never above 100%', () => {
    const bounds = boundsOf([
      { x: 0, y: 0, width: 1440, height: 900 },
      { x: 1520, y: 0, width: 390, height: 844 },
    ])
    expect(bounds).toEqual({ x: 0, y: 0, width: 1910, height: 900 })
    const v = fitViewport(bounds, { width: 1000, height: 800 }, { padding: 50 })
    expect(v.zoom).toBeCloseTo(900 / 1910)
    const topLeft = toScreen(v, { x: 0, y: 0 })
    const bottomRight = toScreen(v, { x: 1910, y: 900 })
    expect(topLeft.x).toBeCloseTo(50)
    expect(1000 - bottomRight.x).toBeCloseTo(50)
    expect(topLeft.y).toBeCloseTo(800 - bottomRight.y)
    expect(fitViewport({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 800 }).zoom).toBe(1)
    expect(fitViewport(null, { width: 1000, height: 800 }).zoom).toBe(1)
  })

  it('centers a frame without changing the zoom', () => {
    const v = centerOn(
      { x: 0, y: 0, zoom: 0.5 },
      { x: 1000, y: 200, width: 400, height: 200 },
      { width: 800, height: 600 },
    )
    expect(v.zoom).toBe(0.5)
    expect(toScreen(v, { x: 1200, y: 300 })).toEqual({ x: 400, y: 300 })
  })

  it('fits every frame with room for the labels above them', () => {
    const size = { width: 1000, height: 800 }
    const v = fitAll([frame('a', 0, 0, 400, 300), frame('b', 500, 100, 200, 100)], {}, size)
    expect(v).toEqual(
      fitViewport({ x: 0, y: -FRAME_LABEL_HEIGHT, width: 700, height: 300 + FRAME_LABEL_HEIGHT }, size, {
        padding: 64,
      }),
    )
    expect(fitAll([], {}, size)).toEqual({ x: 64, y: 64, zoom: 1 })
  })
})

describe('stage helpers', () => {
  it('tells a rect and its label apart from the stage', () => {
    const size = { width: 800, height: 600 }
    expect(isOffscreen({ x: 10, y: 10, width: 100, height: 100 }, size)).toBe(false)
    expect(isOffscreen({ x: 801, y: 10, width: 100, height: 100 }, size)).toBe(true)
    expect(isOffscreen({ x: -120, y: 10, width: 100, height: 100 }, size)).toBe(true)
    expect(isOffscreen({ x: 10, y: -110, width: 100, height: 100 }, size)).toBe(true)
    expect(isOffscreen({ x: 10, y: 600 + FRAME_LABEL_HEIGHT, width: 100, height: 100 }, size)).toBe(false)
    expect(isOffscreen({ x: 10, y: 601 + FRAME_LABEL_HEIGHT, width: 100, height: 100 }, size)).toBe(true)
  })
})

describe('frames on the stage', () => {
  it('uses the frame height, then the measured one, then the guess', () => {
    expect(frameHeight(frame('a', 0, 0, 100, 300))).toBe(300)
    expect(frameHeight(frame('a', 0, 0, 100, null), 1200)).toBe(1200)
    expect(frameHeight(frame('a', 0, 0, 100, null, { measuredHeight: 700 }))).toBe(700)
    expect(frameHeight(frame('a', 0, 0, 100, null))).toBe(AUTO_HEIGHT_GUESS)
    expect(frameRects([frame('a', 5, 6, 100, null)], { a: 50 })).toEqual([
      { id: 'a', x: 5, y: 6, width: 100, height: 50 },
    ])
  })

  it('hit tests the topmost frame', () => {
    const rects = frameRects([frame('a', 0, 0, 100, 100), frame('b', 50, 50, 100, 100)])
    expect(hitTest(rects, { x: 10, y: 10 })).toBe('a')
    expect(hitTest(rects, { x: 60, y: 60 })).toBe('b')
    expect(hitTest(rects, { x: 500, y: 500 })).toBeNull()
  })

  it('lists the frames crossing the screen plus a margin', () => {
    const rects = frameRects([
      frame('a', 0, 0, 100, 100),
      frame('b', 2000, 0, 100, 100),
      frame('c', 1100, 0, 100, 100),
    ])
    const v = { x: 0, y: 0, zoom: 1 }
    expect([...visibleFrameIds(rects, v, { width: 1000, height: 800 }, 0)]).toEqual(['a'])
    expect([...visibleFrameIds(rects, v, { width: 1000, height: 800 }, 150)].sort()).toEqual(['a', 'c'])
    expect(visibleFrameIds(rects, { x: 0, y: 0, zoom: 0.25 }, { width: 1000, height: 800 }, 0).size).toBe(3)
  })

  it('snaps a dragged frame to the edges and centers of the others', () => {
    const others = [{ x: 0, y: 0, width: 400, height: 300 }]
    const near = snapPosition({ x: 404, y: 3, width: 200, height: 100 }, others, 6)
    expect(near).toMatchObject({ x: 400, y: 0 })
    expect(near.guides).toEqual({ x: [400], y: [0] })
    const centered = snapPosition({ x: 500, y: 98, width: 200, height: 100 }, others, 6)
    expect(centered.y).toBe(100)
    const far = snapPosition({ x: 700, y: 700, width: 200, height: 100 }, others, 6)
    expect(far).toEqual({ x: 700, y: 700, guides: { x: [], y: [] } })
  })

  it('previews where a dropped frame lands: pushed clear of the others like the daemon does', () => {
    const rects = frameRects([frame('a', 0, 0, 400, 300), frame('b', 1000, 0, 200, 200)])
    expect(dropSpot({ id: 'b', x: 600, y: 0, width: 200, height: 200 }, rects)).toEqual({
      x: 600,
      y: 0,
      pushed: false,
    })
    const pushed = dropSpot({ id: 'b', x: 100, y: 50, width: 200, height: 200 }, rects)
    expect(pushed.pushed).toBe(true)
    expect(pushed.x >= 440 || pushed.y >= 340 || pushed.x <= -240 || pushed.y <= -240).toBe(true)
  })
})

describe('themes', () => {
  const themes = ['Green', 'Night']
  it('resolves the theme shown: frame override, forced, own, first', () => {
    expect(resolveTheme(themes, 'night')).toBe('Night')
    expect(resolveTheme(themes, 'Missing')).toBe('Green')
    expect(resolveTheme(themes, null)).toBe('Green')
    expect(resolveTheme(themes, 'Green', 'Night')).toBe('Night')
    expect(resolveTheme(themes, 'Night', 'Green', 'Night')).toBe('Night')
    expect(resolveTheme([], null)).toBe('')
  })

  it("keys a theme by its values: another theme's edit doesn't change it", () => {
    const design = {
      themes,
      fonts: [],
      tokens: [
        token('color-primary', 'color', null, { Green: '#0a7', Night: '#123' }),
        token('radius-card', 'number', 12),
      ],
    }
    const green = themeKey(design, 'Green')
    const night = themeKey(design, 'Night')
    expect(green).not.toBe(night)
    const edited = {
      ...design,
      tokens: [
        token('color-primary', 'color', null, { Green: '#0a7', Night: '#456' }),
        design.tokens[1] as DesignToken,
      ],
    }
    expect(themeKey(edited, 'Green')).toBe(green)
    expect(themeKey(edited, 'Night')).not.toBe(night)
    expect(themeKey({ ...design, fonts: ['Fraunces'] }, 'Green')).not.toBe(green)
  })

  it('finds a background color for a frame still loading', () => {
    const design = {
      themes,
      tokens: [token('color-background', 'color', null, { Green: '#fff', Night: '#000' })],
    }
    expect(themeBackground(design, 'Night')).toBe('#000')
    expect(themeBackground({ themes, tokens: [] }, 'Night')).toBeNull()
  })
})

describe('revisions and frame messages', () => {
  it('reads what a revision did from its summary', () => {
    expect(revisionKind('frame Home added')).toBe('added')
    expect(revisionKind('frame Home 2 added (copy of Home)')).toBe('added')
    expect(revisionKind('frame Home rewritten')).toBe('rewritten')
    expect(revisionKind('frame Dark theme page edited')).toBe('edited')
    expect(revisionKind('frame Home theme Night')).toBe('theme')
    expect(revisionKind('frame Home renamed to Landing')).toBe('renamed')
    expect(revisionKind('frame Home restored')).toBe('restored')
    expect(revisionKind('restored tokens')).toBe('restored')
    expect(revisionKind('tokens: color-primary')).toBe('tokens')
    expect(revisionKind('themes Green, Night; tokens color-bg')).toBe('tokens')
    expect(revisionKind('undid tokens: color-primary')).toBe('undone')
    expect(revisionKind('something else')).toBe('changed')
  })

  it('puts the frame in front of the message and reads it back', () => {
    const prefix = frameContextPrefix('Dashboard', 'Onboarding')
    expect(splitFrameContext(`${prefix}\nmake the balance bigger`)).toEqual({
      frame: 'Dashboard',
      text: 'make the balance bigger',
    })
    expect(splitFrameContext('just text')).toEqual({ frame: null, text: 'just text' })
  })
})

describe('draftHeight', () => {
  it('keeps a slide or a printed page at its size, whatever the content measures', () => {
    expect(draftHeight({ width: 1920, height: 1080 }, 1600, undefined)).toBe(1080)
    expect(draftHeight({ width: 794, height: 1123 }, 2000, undefined)).toBe(1123)
  })

  it('grows screens and auto frames with the content, never below their height or a screen shape', () => {
    expect(draftHeight({ width: 1440, height: 900 }, 1673, undefined)).toBe(1673)
    expect(draftHeight({ width: 1440, height: 900 }, 300, undefined)).toBe(900)
    expect(draftHeight({ width: 1440, height: null }, 96, undefined)).toBe(AUTO_HEIGHT_GUESS)
    expect(draftHeight({ width: 390, height: null }, 96, undefined)).toBe(244)
    expect(draftHeight({ width: 1440, height: null }, 96, 3000)).toBe(3000)
    expect(draftHeight({ width: 1440, height: null }, 4660, 3000)).toBe(4660)
  })
})
