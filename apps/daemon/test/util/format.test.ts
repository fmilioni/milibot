import { describe, expect, it } from 'vitest'

import { formatBytesEn } from '../../src/util/format'

describe('formatBytesEn', () => {
  it('formats bytes in English', () => {
    expect(formatBytesEn(512)).toBe('512 B')
    expect(formatBytesEn(1536)).toBe('1.5 KB')
    expect(formatBytesEn(20 * 1024 * 1024)).toBe('20 MB')
    expect(formatBytesEn(5 * 1024 ** 4)).toBe('5120 GB')
  })
})
