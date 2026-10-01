/** Frames on the canvas never overlap: a dropped or moved frame goes to the nearest free spot. */

export interface DesignRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedFrame extends DesignRect {
  id: string
}

export function rectsOverlap(a: DesignRect, b: DesignRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function firstOverlap(
  rect: DesignRect,
  frames: readonly PlacedFrame[],
  exceptId?: string,
): PlacedFrame | null {
  return frames.find((f) => f.id !== exceptId && rectsOverlap(rect, f)) ?? null
}

function bottom(frames: readonly DesignRect[]): number {
  return Math.max(...frames.map((f) => f.y + f.height))
}

/**
 * The free spot nearest to `rect` (the frame keeps its size): candidates are its own position and the
 * positions touching each frame in the way, with `gap` between them.
 */
export function nearestFreeSpot(
  rect: DesignRect,
  frames: readonly PlacedFrame[],
  exceptId?: string,
  gap = 40,
): { x: number; y: number } {
  const others = frames.filter((f) => f.id !== exceptId)
  if (!firstOverlap(rect, others)) return { x: rect.x, y: rect.y }
  const xs = new Set([rect.x])
  const ys = new Set([rect.y])
  for (const f of others) {
    xs.add(f.x + f.width + gap)
    xs.add(f.x - rect.width - gap)
    xs.add(f.x)
    ys.add(f.y + f.height + gap)
    ys.add(f.y - rect.height - gap)
    ys.add(f.y)
  }
  const candidates: Array<{ x: number; y: number; d: number }> = []
  for (const x of xs) for (const y of ys) candidates.push({ x, y, d: (x - rect.x) ** 2 + (y - rect.y) ** 2 })
  candidates.sort((a, b) => a.d - b.d)
  const free = candidates.find((c) => !firstOverlap({ ...c, width: rect.width, height: rect.height }, others))
  return free ? { x: free.x, y: free.y } : { x: rect.x, y: bottom(others) + gap }
}
