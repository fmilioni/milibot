import type { Size } from './tooltip'

/** Where a `fixed` floating layer goes, in viewport pixels (`bottom` anchors it by its bottom edge). */
export interface FloatingPosition {
  left: number
  top?: number
  bottom?: number
  maxHeight?: number
}

export interface Point {
  x: number
  y: number
}

export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

export type PopoverPlacement = 'below-end' | 'above-start'

const MARGIN = 8

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** At a point (context menus), moved back inside the viewport margins when it would overflow. */
export function placeAtPoint(point: Point, size: Size, viewport: Size): FloatingPosition {
  return {
    left: clamp(point.x, MARGIN, viewport.width - size.width - MARGIN),
    top: clamp(point.y, MARGIN, viewport.height - size.height - MARGIN),
  }
}

/** Right of `point` (a submenu next to its item), flipped to the left of it when it doesn't fit. */
export function placeBeside(point: Point, size: Size, viewport: Size): FloatingPosition {
  const fitsRight = point.x + size.width <= viewport.width - MARGIN
  return {
    left: fitsRight ? point.x : Math.max(MARGIN, point.x - size.width - MARGIN),
    top: clamp(point.y, MARGIN, viewport.height - size.height - MARGIN),
  }
}

/**
 * Next to a rect (a comment on something on a canvas): on its right, else its left, else under it, else over
 * it; inside the viewport margins, over the rect only when nothing else fits.
 */
export function placeNextTo(anchor: AnchorRect, size: Size, viewport: Size, gap = 8): FloatingPosition {
  const maxLeft = viewport.width - size.width - MARGIN
  const maxTop = viewport.height - size.height - MARGIN
  const top = clamp(anchor.top, MARGIN, maxTop)
  if (anchor.right + gap <= maxLeft) return { left: anchor.right + gap, top }
  if (anchor.left - gap - size.width >= MARGIN) return { left: anchor.left - gap - size.width, top }
  const left = clamp(anchor.left, MARGIN, maxLeft)
  if (anchor.bottom + gap <= maxTop) return { left, top: anchor.bottom + gap }
  if (anchor.top - gap - size.height >= MARGIN) return { left, top: anchor.top - gap - size.height }
  return { left, top }
}

/**
 * Under the anchor and right-aligned with it (`below-end`), or over it and left-aligned (`above-start`,
 * anchored by its bottom edge so it grows upwards and scrolls past the room above).
 */
export function placePopover(
  anchor: AnchorRect,
  size: Size,
  viewport: Size,
  placement: PopoverPlacement,
  gap = 6,
): FloatingPosition {
  const maxLeft = viewport.width - size.width - MARGIN
  if (placement === 'above-start') {
    return {
      left: clamp(anchor.left, MARGIN, maxLeft),
      bottom: viewport.height - anchor.top + gap,
      maxHeight: anchor.top - gap - MARGIN,
    }
  }
  return {
    left: clamp(anchor.right - size.width, MARGIN, maxLeft),
    top: clamp(anchor.bottom + gap, MARGIN, viewport.height - size.height - MARGIN),
  }
}
