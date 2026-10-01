import { describe, expect, it } from 'vitest'

import { isTransparent, visibleBackground } from './title-bar'

describe('title bar overlay colors', () => {
  it('recognizes transparent backgrounds', () => {
    expect(isTransparent('rgba(0, 0, 0, 0)')).toBe(true)
    expect(isTransparent('transparent')).toBe(true)
    expect(isTransparent('rgb(20 22 26 / 0)')).toBe(true)
    expect(isTransparent('rgb(20 22 26 / 0%)')).toBe(true)
    expect(isTransparent('rgb(20, 22, 26)')).toBe(false)
    expect(isTransparent('rgba(20, 22, 26, 0.9)')).toBe(false)
    expect(isTransparent('#14161a')).toBe(false)
  })

  it('takes the first opaque background from the top, else the fallback', () => {
    expect(visibleBackground(['rgba(0, 0, 0, 0)', 'rgb(20, 22, 26)', 'rgb(13, 14, 17)'], '#fff')).toBe(
      'rgb(20, 22, 26)',
    )
    expect(visibleBackground(['rgba(0, 0, 0, 0)'], '#0d0e11')).toBe('#0d0e11')
    expect(visibleBackground([], '#0d0e11')).toBe('#0d0e11')
  })
})
