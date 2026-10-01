import { describe, expect, it } from 'vitest'

import { windowChrome } from './chrome'

describe('windowChrome', () => {
  it('keeps the inset traffic lights on macOS', () => {
    expect(windowChrome('workspace', 'darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 14 },
    })
    expect(windowChrome('canvas', 'darwin').trafficLightPosition).toEqual({ x: 14, y: 19 })
    expect(windowChrome('vm', 'darwin').trafficLightPosition).toEqual({ x: 14, y: 13 })
  })

  it('uses the standard frame on Linux with the menu bar hidden until Alt', () => {
    const options = windowChrome('workspace', 'linux')
    expect(options).toEqual({ autoHideMenuBar: true })
    expect(options.titleBarStyle).toBeUndefined()
  })

  it('overlays the caption buttons on Windows in the theme colors', () => {
    expect(windowChrome('workspace', 'win32', true)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0D0E11', symbolColor: '#E8E9EC', height: 40 },
    })
    expect(windowChrome('canvas', 'win32').titleBarOverlay).toMatchObject({ color: '#FBFBFA', height: 52 })
  })
})
