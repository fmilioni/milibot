import type { DesignRect } from '@milibot/shared'

/** Where the canvas is looking: a world point `p` shows at `p * zoom + (x, y)` on screen. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export const MIN_ZOOM = 0.02
export const MAX_ZOOM = 4

const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4]

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function toScreen(viewport: Viewport, point: Point): Point {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y }
}

export function toWorld(viewport: Viewport, point: Point): Point {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom }
}

/** Zooms to `zoom` keeping the world point under `anchor` (screen coordinates) where it is. */
export function zoomAt(viewport: Viewport, zoom: number, anchor: Point): Viewport {
  const next = clampZoom(zoom)
  const world = toWorld(viewport, anchor)
  return { zoom: next, x: anchor.x - world.x * next, y: anchor.y - world.y * next }
}

/** Zoom factor of a wheel/pinch delta (pinch arrives as a ctrl+wheel with small deltas). */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaY
  return Math.exp(-Math.max(-25, Math.min(25, pixels)) * 0.01)
}

/** Next zoom step up (`1`) or down (`-1`) from `zoom` (⌘+ / ⌘−, the − and + buttons). */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction === 1) return ZOOM_STEPS.find((z) => z > zoom + 1e-6) ?? MAX_ZOOM
  return [...ZOOM_STEPS].reverse().find((z) => z < zoom - 1e-6) ?? MIN_ZOOM
}

export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100)
}

/** The viewport showing `bounds` whole and centered, with `padding` screen pixels around it. */
export function fitViewport(
  bounds: DesignRect | null,
  size: Size,
  { padding = 64, maxZoom = 1 }: { padding?: number; maxZoom?: number } = {},
): Viewport {
  if (!bounds || size.width <= 0 || size.height <= 0) return { x: padding, y: padding, zoom: 1 }
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (size.width - padding * 2) / Math.max(1, bounds.width),
      (size.height - padding * 2) / Math.max(1, bounds.height),
    ),
  )
  return {
    zoom,
    x: (size.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (size.height - bounds.height * zoom) / 2 - bounds.y * zoom,
  }
}
