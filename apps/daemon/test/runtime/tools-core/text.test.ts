import { describe, expect, it } from 'vitest'

import { clipMiddle, foldKey, oneLine, stripAnsi } from '../../../src/runtime/tools-core'

describe('tool text', () => {
  it('clips text to one line', () => {
    expect(oneLine('  a\n\n b\tc ', 10)).toBe('a b c')
    expect(oneLine('abcdefghijkl', 6)).toBe('abcde…')
  })

  it('clips long output in the middle, keeping its start and its end', () => {
    expect(clipMiddle('short', 10)).toBe('short')
    expect(clipMiddle('0123456789abcdefghij', 10)).toBe('0123\n… [10 characters omitted] …\nefghij')
  })

  it('folds names for comparison', () => {
    expect(foldKey('  Café Q3 ')).toBe('cafe q3')
  })

  it('strips terminal escapes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })
})
