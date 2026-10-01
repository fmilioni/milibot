import { describe, expect, it } from 'vitest'

import { clampPan, IMAGE_PADDING, initialImageViewport, toggleZoomAt } from './image-view'

const stage = { width: 1000, height: 800 }

describe('initialImageViewport', () => {
  it('shows a small image whole at 100%, centered', () => {
    expect(initialImageViewport({ width: 400, height: 200 }, stage)).toEqual({ zoom: 1, x: 300, y: 300 })
  })

  it('shrinks a large image that is not tall to fit whole', () => {
    const v = initialImageViewport({ width: 2000, height: 1000 }, stage)
    expect(v.zoom).toBeCloseTo((1000 - IMAGE_PADDING * 2) / 2000)
  })

  it('opens a tall image at its width from the top', () => {
    expect(initialImageViewport({ width: 800, height: 6000 }, stage)).toEqual({
      zoom: 1,
      x: 100,
      y: IMAGE_PADDING,
    })
    const wide = initialImageViewport({ width: 1872, height: 9000 }, stage)
    expect(wide.zoom).toBeCloseTo(0.5)
    expect(wide.x).toBeCloseTo(IMAGE_PADDING)
    expect(wide.y).toBe(IMAGE_PADDING)
  })
})

describe('clampPan', () => {
  const tall = { width: 800, height: 6000 }

  it('centers the axis the image fits in', () => {
    expect(clampPan({ zoom: 1, x: -500, y: 0 }, tall, stage).x).toBe(100)
  })

  it('stops the edges just inside the stage on the axis it overflows', () => {
    expect(clampPan({ zoom: 1, x: 0, y: 400 }, tall, stage).y).toBe(IMAGE_PADDING)
    expect(clampPan({ zoom: 1, x: 0, y: -99999 }, tall, stage).y).toBe(800 - 6000 - IMAGE_PADDING)
    expect(clampPan({ zoom: 1, x: 0, y: -1234 }, tall, stage).y).toBe(-1234)
  })
})

describe('toggleZoomAt', () => {
  const image = { width: 800, height: 6000 }
  const anchor = { x: 500, y: 400 }

  it('steps to 100%, then 200% around the point, then back to the opening view', () => {
    const first = toggleZoomAt({ zoom: 0.25, x: 400, y: 32 }, anchor, image, stage)
    expect(first).toEqual({ zoom: 1, x: 500 - (500 - 400) * 4, y: 400 - (400 - 32) * 4 })
    expect(toggleZoomAt(first, anchor, image, stage).zoom).toBe(2)
    expect(toggleZoomAt({ zoom: 2, x: 0, y: 0 }, anchor, image, stage)).toEqual(
      initialImageViewport(image, stage),
    )
  })
})
