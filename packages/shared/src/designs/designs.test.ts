import { describe, expect, it } from 'vitest'

import { isPagedSize } from './designs'

describe('isPagedSize', () => {
  it('tells slides and printed pages from screens, in either orientation', () => {
    expect(isPagedSize(1920, 1080)).toBe(true)
    expect(isPagedSize(1080, 1920)).toBe(true)
    expect(isPagedSize(1024, 768)).toBe(true)
    expect(isPagedSize(794, 1123)).toBe(true)
    expect(isPagedSize(816, 1056)).toBe(true)
    expect(isPagedSize(1440, 900)).toBe(false)
    expect(isPagedSize(390, 844)).toBe(false)
    expect(isPagedSize(512, 512)).toBe(false)
  })
})
