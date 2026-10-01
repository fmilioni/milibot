import { clampZoom, fitViewport, type Point, type Size, type Viewport, zoomAt } from './viewport'

/** Screen space kept around an image that fits, and the most an edge can be dragged past the stage. */
export const IMAGE_PADDING = 32

/** The whole image, centered, at most 100%. */
export function fitImage(image: Size, stage: Size): Viewport {
  return fitViewport({ x: 0, y: 0, ...image }, stage, { padding: IMAGE_PADDING })
}

/** Whole when that keeps it readable; an image taller than the stage opens at its width (≤ 100%) from the top. */
export function initialImageViewport(image: Size, stage: Size): Viewport {
  const byWidth = clampZoom(Math.min(1, (stage.width - IMAGE_PADDING * 2) / Math.max(1, image.width)))
  if (image.height * byWidth <= stage.height - IMAGE_PADDING * 2) return fitImage(image, stage)
  return { zoom: byWidth, x: (stage.width - image.width * byWidth) / 2, y: IMAGE_PADDING }
}

function clampAxis(offset: number, length: number, stage: number): number {
  if (length <= stage - IMAGE_PADDING * 2) return (stage - length) / 2
  return Math.min(IMAGE_PADDING, Math.max(stage - length - IMAGE_PADDING, offset))
}

/** Centers each axis the image fits in; on the others, its edges stop at `IMAGE_PADDING` inside the stage. */
export function clampPan(viewport: Viewport, image: Size, stage: Size): Viewport {
  return {
    zoom: viewport.zoom,
    x: clampAxis(viewport.x, image.width * viewport.zoom, stage.width),
    y: clampAxis(viewport.y, image.height * viewport.zoom, stage.height),
  }
}

/** Double click: below 100% goes to 100%, then 200%, then back to how the image opened. */
export function toggleZoomAt(viewport: Viewport, anchor: Point, image: Size, stage: Size): Viewport {
  if (viewport.zoom < 1 - 1e-6) return zoomAt(viewport, 1, anchor)
  if (viewport.zoom < 2 - 1e-6) return zoomAt(viewport, 2, anchor)
  return initialImageViewport(image, stage)
}
