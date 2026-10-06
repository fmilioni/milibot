import type { Box, Point } from './bot-cursor'

const isRoot = (el: Element) => el.tagName === 'HTML' || el.tagName === 'BODY'

/** Inside an SVG the whole drawing is the element (an icon's paths are not things to point at). */
function pickable(el: Element): Element {
  let svg: Element | null = el.closest('svg')
  while (svg?.parentElement?.closest('svg')) svg = svg.parentElement.closest('svg')
  return svg ?? el
}

function contains(el: Element, point: Point): boolean {
  const r = el.getBoundingClientRect()
  return (
    r.width > 0 &&
    r.height > 0 &&
    point.x >= r.left &&
    point.x < r.right &&
    point.y >= r.top &&
    point.y < r.bottom
  )
}

/** The child of `el` under `point` (the last one painted wins), or null; never inside an SVG. */
export function childAt(el: Element, point: Point): Element | null {
  if (el.closest('svg')) return null
  const children = Array.from(el.children)
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as Element
    if (contains(child, point)) return child
  }
  return null
}

/**
 * The deepest element of a frame's page under `point` (page pixels), never `html` or `body`. Elements with
 * `pointer-events: none` are invisible to the browser's hit test, so the search goes on by their boxes.
 */
export function elementAt(doc: Document, point: Point): Element | null {
  const body = doc.body
  if (!body) return null
  const hits = typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(point.x, point.y) : []
  let el: Element | null = hits.find((hit) => !isRoot(hit) && body.contains(hit)) ?? null
  el = el ? pickable(el) : childAt(body, point)
  for (let child = el && childAt(el, point); child; child = childAt(child, point)) el = child
  return el ? pickable(el) : null
}

/** The element's parent to select next, or null at the top of the page. */
export function parentOf(el: Element): Element | null {
  const parent = el.parentElement
  return parent && !isRoot(parent) ? parent : null
}

/** From the page's top element down to `el`. */
export function trailOf(el: Element): Element[] {
  const trail: Element[] = []
  for (let at: Element | null = el; at; at = parentOf(at)) trail.unshift(at)
  return trail
}

/** Where the element is in its page (page pixels). */
export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}
