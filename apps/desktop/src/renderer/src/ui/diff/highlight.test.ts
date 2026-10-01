import { describe, expect, it } from 'vitest'

import { highlightLine } from './highlight'

describe('highlightLine', () => {
  it('highlights known languages and leaves the rest plain', () => {
    const segments = highlightLine('const x: number = 1', 'typescript')
    expect(segments?.map((s) => s.text).join('')).toBe('const x: number = 1')
    expect(segments?.find((s) => s.text === 'const')?.className).toContain('keyword')
    expect(highlightLine('<div />', 'tsx')).not.toBeNull()
    expect(highlightLine('whatever', 'klingon')).toBeNull()
    expect(highlightLine('x', undefined)).toBeNull()
  })
})
