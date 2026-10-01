import { describe, expect, it } from 'vitest'

import { VM_TOOLBAR_HEIGHT, vmWindowSize } from './vm-size'

describe('vmWindowSize', () => {
  it('shows the desktop 1:1 when the screen has room', () => {
    expect(vmWindowSize({ width: 1728, height: 1079 })).toEqual({
      width: 1280,
      height: 800 + VM_TOOLBAR_HEIGHT,
    })
  })

  it('keeps 16:10 on a smaller screen', () => {
    const size = vmWindowSize({ width: 1440, height: 800 })
    expect(size.height).toBe(800)
    expect((size.height - VM_TOOLBAR_HEIGHT) / size.width).toBeCloseTo(800 / 1280, 2)
    expect(vmWindowSize({ width: 1024, height: 1000 }).width).toBe(1024)
  })
})
