import { describe, expect, it } from 'vitest'

import { intraLineRanges, markSegments, type Range, tokenize } from './word-diff'

const pick = (text: string, ranges: Range[]) => ranges.map(([start, end]) => text.slice(start, end))

describe('tokenize', () => {
  it('splits words, spaces and punctuation', () => {
    expect(tokenize('h-[46px]  shrink-0 café')).toEqual([
      'h',
      '-',
      '[',
      '46px',
      ']',
      '  ',
      'shrink',
      '-',
      '0',
      ' ',
      'café',
    ])
  })
})

describe('intraLineRanges', () => {
  it('marks only what was inserted', () => {
    const before = '{/* Title-bar zone: draggable, clear of the traffic lights. */}'
    const after = '{/* Title-bar zone: draggable, clear of the traffic lights on macOS. */}'
    const ranges = intraLineRanges(before, after)
    expect(ranges?.before).toEqual([])
    expect(pick(after, ranges!.after)).toEqual(['on macOS'])
  })

  it('marks replaced and moved words on both sides', () => {
    const before = '<div className="drag-region h-[46px] shrink-0" />'
    const after = '<div className="drag-region h-3 shrink-0 mac:h-[46px]" />'
    const ranges = intraLineRanges(before, after)!
    expect(pick(before, ranges.before)).toEqual(['[46px]'])
    expect(pick(after, ranges.after)).toEqual(['3', 'mac:h-[46px]'])
  })

  it('joins changes apart only by spaces', () => {
    const ranges = intraLineRanges('const total = a + b', 'const total = x * y')!
    expect(pick('const total = x * y', ranges.after)).toEqual(['x * y'])
  })

  it('gives up on rewritten, identical, blank or huge lines', () => {
    expect(intraLineRanges('const x = 1', 'return fetchUsers(page)')).toBeNull()
    expect(intraLineRanges('same', 'same')).toBeNull()
    expect(intraLineRanges('', 'something')).toBeNull()
    expect(intraLineRanges('a'.repeat(3000), 'b')).toBeNull()
  })
})

describe('markSegments', () => {
  it('splits highlighted runs at the range edges and keeps their classes', () => {
    const segments = [
      { text: 'const', className: 'keyword' },
      { text: ' x = ', className: '' },
      { text: '10', className: 'number' },
    ]
    expect(
      markSegments(
        segments,
        [
          [4, 7],
          [10, 11],
        ],
        'mark',
      ),
    ).toEqual([
      { text: 'cons', className: 'keyword' },
      { text: 't', className: 'keyword mark' },
      { text: ' x', className: 'mark' },
      { text: ' = ', className: '' },
      { text: '1', className: 'number mark' },
      { text: '0', className: 'number' },
    ])
  })

  it('returns the runs untouched without ranges', () => {
    const segments = [{ text: 'x', className: '' }]
    expect(markSegments(segments, [], 'mark')).toBe(segments)
  })
})
