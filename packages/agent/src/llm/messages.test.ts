import { describe, expect, it } from 'vitest'

import { systemCacheParts, textOfParts } from './messages'

describe('textOfParts', () => {
  it('joins the text parts and skips images', () => {
    const image = {
      type: 'image' as const,
      sha256: 'x',
      mediaType: 'image/png' as const,
      width: 1,
      height: 1,
    }
    expect(textOfParts([{ type: 'text', text: 'a' }, image, { type: 'text', text: 'b' }], '\n')).toBe('a\nb')
    expect(
      textOfParts([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab')
  })
})

describe('systemCacheParts', () => {
  it('marks the flagged parts, else the last one, and drops empty text', () => {
    expect(
      systemCacheParts([
        { role: 'system', content: [{ type: 'text', text: 'rules', cacheBreakpoint: true }] },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'memory' },
            { type: 'text', text: '' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'hi', cacheBreakpoint: true }] },
      ]),
    ).toEqual([
      { text: 'rules', breakpoint: true },
      { text: 'memory', breakpoint: false },
    ])
    expect(
      systemCacheParts([
        {
          role: 'system',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ]),
    ).toEqual([
      { text: 'a', breakpoint: false },
      { text: 'b', breakpoint: true },
    ])
  })
})
