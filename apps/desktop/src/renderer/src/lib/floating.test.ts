import { describe, expect, it } from 'vitest'

import { placeAtPoint, placeBeside, placePopover } from './floating'

const viewport = { width: 1000, height: 800 }
const size = { width: 200, height: 300 }

describe('placeAtPoint', () => {
  it('stays at the point when it fits', () => {
    expect(placeAtPoint({ x: 100, y: 120 }, size, viewport)).toEqual({ left: 100, top: 120 })
  })

  it('moves back inside the margins near the edges', () => {
    expect(placeAtPoint({ x: 950, y: 700 }, size, viewport)).toEqual({ left: 792, top: 492 })
    expect(placeAtPoint({ x: -20, y: 2 }, size, viewport)).toEqual({ left: 8, top: 8 })
  })
})

describe('placeBeside', () => {
  it('goes right of the point, or flips to its left when it does not fit', () => {
    expect(placeBeside({ x: 300, y: 100 }, size, viewport)).toEqual({ left: 300, top: 100 })
    expect(placeBeside({ x: 900, y: 100 }, size, viewport)).toEqual({ left: 692, top: 100 })
  })
})

describe('placePopover', () => {
  const anchor = { left: 500, top: 400, right: 560, bottom: 430 }

  it('below-end lines up the right edges under the anchor', () => {
    expect(placePopover(anchor, size, viewport, 'below-end')).toEqual({ left: 360, top: 436 })
  })

  it('below-end is kept on screen', () => {
    const low = { left: 20, top: 700, right: 60, bottom: 730 }
    expect(placePopover(low, size, viewport, 'below-end')).toEqual({ left: 8, top: 492 })
  })

  it('above-start sits over the anchor by its bottom edge with the room above as max height', () => {
    expect(placePopover(anchor, size, viewport, 'above-start')).toEqual({
      left: 500,
      bottom: 406,
      maxHeight: 386,
    })
  })
})
