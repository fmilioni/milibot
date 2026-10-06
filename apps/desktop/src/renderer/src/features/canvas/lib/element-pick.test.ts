// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { childAt, elementAt, parentOf, trailOf } from './element-pick'

/** A page whose elements sit at the given boxes; `hits` stands in for the browser's hit test. */
function page(html: string, boxes: Record<string, [number, number, number, number]>, hits: string[]) {
  const doc = document.implementation.createHTMLDocument('')
  doc.body.innerHTML = html
  for (const [selector, [x, y, width, height]] of Object.entries(boxes)) {
    const el = doc.querySelector(selector) as Element
    el.getBoundingClientRect = () => new DOMRect(x, y, width, height)
  }
  doc.elementsFromPoint = () => hits.map((s) => (s === 'body' ? doc.body : (doc.querySelector(s) as Element)))
  return doc
}

const html =
  '<main id="m"><nav id="n"><a id="a">Home <span id="s">new</span></a></nav><svg id="g"><path id="p"></path></svg></main>'
const boxes: Record<string, [number, number, number, number]> = {
  '#m': [0, 0, 400, 300],
  '#n': [0, 0, 400, 40],
  '#a': [10, 10, 80, 20],
  '#s': [50, 10, 40, 20],
  '#g': [10, 100, 24, 24],
  '#p': [12, 102, 20, 20],
}

describe('elementAt', () => {
  it('never returns html or body', () => {
    const doc = page(html, boxes, ['body'])
    expect(elementAt(doc, { x: 390, y: 290 })?.id).toBe('m')
    expect(elementAt(page(html, boxes, ['body']), { x: 900, y: 900 })).toBeNull()
  })

  it('goes on into elements the hit test skips (pointer-events: none)', () => {
    // The browser stops at the link: its badge has pointer-events: none.
    const doc = page(html, boxes, ['#a', '#n', '#m', 'body'])
    expect(elementAt(doc, { x: 60, y: 15 })?.id).toBe('s')
    expect(elementAt(doc, { x: 20, y: 15 })?.id).toBe('a')
  })

  it('takes a whole SVG instead of its shapes', () => {
    const doc = page(html, boxes, ['#p', '#g', '#m', 'body'])
    expect(elementAt(doc, { x: 15, y: 105 })?.id).toBe('g')
  })
})

describe('walking the tree', () => {
  const doc = page(html, boxes, [])
  const span = doc.getElementById('s') as Element

  it('stops below the body going up', () => {
    expect(trailOf(span).map((el) => el.id)).toEqual(['m', 'n', 'a', 's'])
    expect(parentOf(doc.getElementById('m') as Element)).toBeNull()
  })

  it('goes down to the child under a point', () => {
    expect(childAt(doc.getElementById('n') as Element, { x: 20, y: 15 })?.id).toBe('a')
    expect(childAt(doc.getElementById('n') as Element, { x: 200, y: 15 })).toBeNull()
    expect(childAt(doc.getElementById('g') as Element, { x: 15, y: 105 })).toBeNull()
  })
})
