import { describe, expect, it } from 'vitest'

import { applyFrameEdits } from '../../../src/runtime/design/frames'

describe('frame edits', () => {
  it('replaces exact, unique text in the HTML or the CSS, all or nothing', () => {
    const html = '<h1 class="text-xl">Hello</h1><p>Hello world</p>'
    const css = '.card { color: red; }'
    expect(
      applyFrameEdits(html, css, [
        { oldText: '<h1 class="text-xl">', newText: '<h1 class="text-3xl">' },
        { oldText: 'color: red', newText: 'color: blue' },
      ]),
    ).toEqual({ html: '<h1 class="text-3xl">Hello</h1><p>Hello world</p>', css: '.card { color: blue; }' })
    expect(() => applyFrameEdits(html, css, [{ oldText: 'Hello', newText: 'Hi' }])).toThrow(/matches 2 times/)
    expect(() =>
      applyFrameEdits(html, css, [
        { oldText: 'world', newText: 'earth' },
        { oldText: 'missing', newText: 'x' },
      ]),
    ).toThrow(/edits\[1\]: old_text was not found/)
  })
})
