export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** One element of a rendered frame: what it holds itself (tag, attributes, own text) and where it is. */
export interface ElementShot {
  signature: string
  box: Box
  /** Index of the parent element's shot; -1 for the body's children. */
  parent: number
}

const ATTRIBUTE_CHARS = 120

function ownSignature(el: Element): string {
  const attrs = Array.from(el.attributes, (a) =>
    a.value.length > ATTRIBUTE_CHARS
      ? `${a.name}=${a.value.slice(0, ATTRIBUTE_CHARS)}…${a.value.length}`
      : `${a.name}=${a.value}`,
  ).sort()
  let text = ''
  for (const node of Array.from(el.childNodes)) if (node.nodeType === 3) text += node.textContent ?? ''
  return `${el.tagName}|${attrs.join(' ')}|${text.trim()}`
}

/** The elements of a frame's page, in document order (reads the layout of a loaded same-origin iframe). */
export function snapshotPage(doc: Document): ElementShot[] {
  const body = doc.body
  if (!body) return []
  const elements = Array.from(body.querySelectorAll('*'))
  const index = new Map(elements.map((el, i) => [el, i]))
  return elements.map((el) => {
    const r = el.getBoundingClientRect()
    return {
      signature: ownSignature(el),
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      parent: el.parentElement ? (index.get(el.parentElement) ?? -1) : -1,
    }
  })
}

export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Where a page changed from `before` (null: everything is new): the box around the visible elements whose own
 * tag, attributes or text did not exist before. Null when nothing visible changed.
 */
export function changedRegion(before: ElementShot[] | null, after: ElementShot[]): Box | null {
  const left = new Map<string, number>()
  for (const shot of before ?? []) left.set(shot.signature, (left.get(shot.signature) ?? 0) + 1)
  const changed: Box[] = []
  for (const shot of after) {
    const count = left.get(shot.signature) ?? 0
    if (count > 0) left.set(shot.signature, count - 1)
    else if (shot.box.width > 0 && shot.box.height > 0) changed.push(shot.box)
  }
  return union(changed)
}

export function clampBox(box: Box, bounds: Box): Box | null {
  const x = Math.max(box.x, bounds.x)
  const y = Math.max(box.y, bounds.y)
  const right = Math.min(box.x + box.width, bounds.x + bounds.width)
  const bottom = Math.min(box.y + box.height, bounds.y + bounds.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** A random point inside `box`, away from its edges when it is big enough. */
export function randomPointIn(box: Box, random: () => number = Math.random): Point {
  const mx = Math.min(box.width * 0.2, 40)
  const my = Math.min(box.height * 0.2, 24)
  return {
    x: box.x + mx + random() * Math.max(0, box.width - 2 * mx),
    y: box.y + my + random() * Math.max(0, box.height - 2 * my),
  }
}

export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
}

/** How long the cursor takes to glide `distance` screen pixels. */
export function glideMs(distance: number): number {
  return Math.round(Math.min(500, Math.max(300, 300 + distance * 0.35)))
}

/** The slow drift of a cursor at rest (screen pixels): a few incommensurable sines, different per seed. */
export function idleDrift(ms: number, seed: number): Point {
  const t = ms / 1000
  return {
    x: 5 * Math.sin(t * 1.7 + seed) + 3 * Math.sin(t * 0.63 + seed * 2.3),
    y: 4 * Math.sin(t * 1.3 + seed * 1.7) + 2.5 * Math.sin(t * 0.47 + seed * 0.9),
  }
}

/** A stable number per bot for `idleDrift`. */
export function driftSeed(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return (Math.abs(h) % 1000) / 100
}

/** `k` (0–1) of the way along a polyline, by distance. */
export function pointAlong(points: readonly Point[], k: number): Point | null {
  const first = points[0]
  if (!first) return null
  const lengths = points.slice(1).map((p, i) => {
    const prev = points[i] as Point
    return Math.hypot(p.x - prev.x, p.y - prev.y)
  })
  const total = lengths.reduce((a, b) => a + b, 0)
  let left = Math.min(1, Math.max(0, k)) * total
  for (const [i, length] of lengths.entries()) {
    const a = points[i] as Point
    const b = points[i + 1] as Point
    if (left <= length) {
      const t = length === 0 ? 1 : left / length
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    left -= length
  }
  return points[points.length - 1] as Point
}

export interface PenMark {
  index: number
  length: number
}

/** Along the outline from where the pen stopped (a new shape starts over), in frame pixels. */
export function penTrail(doc: Document, previous: PenMark | null): { trail: Point[]; mark: PenMark } | null {
  const shapes = doc.querySelectorAll('path, circle, ellipse, rect, line, polyline, polygon')
  const index = shapes.length - 1
  const shape = shapes[index] as (SVGGraphicsElement & Partial<SVGGeometryElement>) | undefined
  const ctm = shape?.getScreenCTM()
  if (!shape || !ctm || typeof shape.getTotalLength !== 'function' || !shape.getPointAtLength) return null
  const total = shape.getTotalLength()
  const from = previous?.index === index ? Math.min(previous.length, total) : 0
  const steps = Math.min(40, Math.max(2, Math.ceil((total - from) / 4)))
  const trail: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const p = shape.getPointAtLength(from + ((total - from) * i) / steps).matrixTransform(ctm)
    trail.push({ x: p.x, y: p.y })
  }
  return { trail, mark: { index, length: total } }
}

export interface CursorEntryShape {
  botId: string
  name: string
  color: string
  visible: boolean
  lastActivity: number | null
  goal: { key: string; box: Box }
}

/** Same cursor content: entries are rebuilt on every render, so identity says nothing. */
export function sameCursorEntry(a: CursorEntryShape, b: CursorEntryShape): boolean {
  return (
    a.botId === b.botId &&
    a.name === b.name &&
    a.color === b.color &&
    a.visible === b.visible &&
    a.lastActivity === b.lastActivity &&
    a.goal.key === b.goal.key &&
    a.goal.box.x === b.goal.box.x &&
    a.goal.box.y === b.goal.box.y &&
    a.goal.box.width === b.goal.box.width &&
    a.goal.box.height === b.goal.box.height
  )
}
