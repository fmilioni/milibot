import { afterEach, describe, expect, it } from 'vitest'

import type { Box, ElementShot } from './bot-cursor'
import { changedElements, forgetShownPages, MAX_FLASH_BOXES, pageChanged } from './change-flash'

/** An element: its own signature, its box (y = its row when omitted) and its children. */
interface Node {
  s: string
  y?: number
  h?: number
  c?: Node[]
}

/** Shots in document order, like `snapshotPage`; boxes are rows 20px tall unless given. */
function page(nodes: Node[]): ElementShot[] {
  const shots: ElementShot[] = []
  const add = (node: Node, parent: number) => {
    const index = shots.length
    const y = node.y ?? index * 20
    shots.push({ signature: node.s, box: { x: 0, y, width: 100, height: node.h ?? 20 }, parent })
    for (const child of node.c ?? []) add(child, index)
  }
  for (const node of nodes) add(node, -1)
  return shots
}

const ys = (boxes: Box[]) => boxes.map((b) => b.y)

describe('changedElements', () => {
  const list = (items: string[]): Node[] => [
    {
      s: 'UL||',
      y: 0,
      h: 200,
      c: items.map((name, i) => ({ s: 'LI|class=row|', y: i * 20, c: [{ s: `SPAN||${name}`, y: i * 20 }] })),
    },
  ]

  it('outlines nothing when the page is the same', () => {
    expect(changedElements(page(list(['a', 'b'])), page(list(['a', 'b'])))).toEqual([])
  })

  it('outlines an inserted element as a whole, not its children or the container', () => {
    const before = page([{ s: 'MAIN||', c: [{ s: 'H1||Title' }] }])
    const after = page([
      {
        s: 'MAIN||',
        c: [
          { s: 'H1||Title' },
          {
            s: 'BUTTON|class=btn|Save',
            y: 300,
            c: [{ s: 'SVG|data-icon=lucide:check|', y: 300, c: [{ s: 'PATH|d=M0|', y: 300 }] }],
          },
        ],
      },
    ])
    expect(ys(changedElements(before, after))).toEqual([300])
  })

  it('outlines an element whose own text or classes changed', () => {
    const before = page([
      {
        s: 'MAIN||',
        c: [
          { s: 'P||Hello', y: 40 },
          { s: 'P|class=a|Bye', y: 80 },
        ],
      },
    ])
    const after = page([
      {
        s: 'MAIN||',
        c: [
          { s: 'P||Hello world', y: 40 },
          { s: 'P|class=b|Bye', y: 80 },
        ],
      },
    ])
    expect(ys(changedElements(before, after))).toEqual([40, 80])
  })

  it('outlines only the deepest change when a container changed too', () => {
    const before = page([
      {
        s: 'NAV|class=a|',
        y: 0,
        c: [
          { s: 'A||Home', y: 10 },
          { s: 'A||Docs', y: 30 },
        ],
      },
    ])
    const after = page([
      {
        s: 'NAV|class=b|',
        y: 0,
        c: [
          { s: 'A||Home', y: 10 },
          { s: 'A||Guides', y: 30 },
        ],
      },
    ])
    expect(ys(changedElements(before, after))).toEqual([30])
  })

  it('outlines a container that changed while its children did not', () => {
    const before = page([{ s: 'NAV|class=a|', y: 0, c: [{ s: 'A||Home', y: 10 }] }])
    const after = page([{ s: 'NAV|class=b|', y: 0, c: [{ s: 'A||Home', y: 10 }] }])
    expect(ys(changedElements(before, after))).toEqual([0])
  })

  it('finds the item inserted in the middle of repeated ones', () => {
    const before = page(list(['alice', 'carol']))
    const after = page(list(['alice', 'bob', 'carol']))
    // Bob's row is new as a whole; Carol's row only moved down.
    expect(ys(changedElements(before, after))).toEqual([20])
  })

  it('counts identical elements', () => {
    const before = page([{ s: 'DIV||', c: [{ s: 'HR||', y: 10 }] }])
    const after = page([
      {
        s: 'DIV||',
        c: [
          { s: 'HR||', y: 10 },
          { s: 'HR||', y: 50 },
        ],
      },
    ])
    expect(ys(changedElements(before, after))).toEqual([50])
  })

  it('skips elements without area', () => {
    const before = page([{ s: 'DIV||' }])
    const after = page([{ s: 'DIV||', c: [{ s: 'SPAN||', h: 0 }] }])
    expect(changedElements(before, after)).toEqual([])
  })

  it('outlines one box around everything past the limit', () => {
    const items = Array.from({ length: MAX_FLASH_BOXES + 1 }, (_, i) => ({
      s: `P||${i}`,
      y: 100 + i * 10,
      h: 10,
    }))
    const boxes = changedElements(
      page([{ s: 'DIV||', y: 0, h: 1000 }]),
      page([{ s: 'DIV||', y: 0, h: 1000, c: items }]),
    )
    expect(boxes).toEqual([{ x: 0, y: 100, width: 100, height: (MAX_FLASH_BOXES + 1) * 10 }])
    const fewer = items.slice(0, MAX_FLASH_BOXES)
    expect(changedElements(page([{ s: 'DIV||' }]), page([{ s: 'DIV||', c: fewer }]))).toHaveLength(
      MAX_FLASH_BOXES,
    )
  })
})

describe('pageChanged', () => {
  afterEach(() => forgetShownPages())
  const v1 = page([{ s: 'DIV||', c: [{ s: 'P||one', y: 40 }] }])
  const v2 = page([{ s: 'DIV||', c: [{ s: 'P||two', y: 40 }] }])

  it('outlines nothing on the first load of a frame', () => {
    expect(pageChanged('frm_1', 'light', v2)).toEqual([])
  })

  it('compares with the page the frame showed before, even from a new iframe', () => {
    pageChanged('frm_1', 'light', v1)
    // The iframe came back (scrolled into view) with the same page.
    expect(pageChanged('frm_1', 'light', v1)).toEqual([])
    expect(ys(pageChanged('frm_1', 'light', v2))).toEqual([40])
    expect(pageChanged('frm_2', 'light', v1)).toEqual([])
  })

  it('outlines nothing when the look changed', () => {
    pageChanged('frm_1', 'light', v1)
    expect(pageChanged('frm_1', 'dark', v2)).toEqual([])
    expect(ys(pageChanged('frm_1', 'dark', v1))).toEqual([40])
  })
})
