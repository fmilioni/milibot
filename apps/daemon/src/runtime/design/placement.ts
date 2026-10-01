import { type DesignRect, firstOverlap, type PlacedFrame } from '@milibot/shared'

/** Space between frames placed automatically. */
export const FRAME_GAP = 80
/** A row of automatically placed frames wraps after this width. */
export const ROW_WIDTH = 4000

function bottom(frames: readonly DesignRect[]): number {
  return Math.max(...frames.map((f) => f.y + f.height))
}

/**
 * Position of a new frame: right of the last one (in order) with a gap, wrapping into a new row past
 * `ROW_WIDTH`; skips over anything in the way.
 */
export function autoPlace(
  frames: readonly PlacedFrame[],
  size: { width: number; height: number },
): DesignRect {
  if (frames.length === 0) return { x: 0, y: 0, ...size }
  const last = frames[frames.length - 1] as PlacedFrame
  const left = Math.min(...frames.map((f) => f.x))
  let rect: DesignRect = { x: last.x + last.width + FRAME_GAP, y: last.y, ...size }
  for (let guard = 0; guard < frames.length * 4 + 8; guard++) {
    if (rect.x + rect.width > left + ROW_WIDTH && rect.x > left) {
      const row = frames.filter((f) => f.y < rect.y + rect.height && f.y + f.height > rect.y)
      rect = { ...rect, x: left, y: (row.length ? bottom(row) : rect.y) + FRAME_GAP }
    }
    const hit = firstOverlap(rect, frames)
    if (!hit) return rect
    rect = { ...rect, x: hit.x + hit.width + FRAME_GAP }
  }
  return { x: left, y: bottom(frames) + FRAME_GAP, ...size }
}
