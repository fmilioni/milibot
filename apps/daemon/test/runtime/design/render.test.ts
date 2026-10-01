import { describe, expect, it } from 'vitest'

import { ChromeDesignRenderer } from '../../../src/runtime/design/render'
import type { VmController } from '../../../src/runtime/vm/controller'

describe('renderer', () => {
  it('lets go of its Chrome quietly when the VM stops', async () => {
    let listener: ((info: { state: string }) => void) | null = null
    let state = 'running'
    const vm = {
      subscribe: (fn: (info: { state: string }) => void) => {
        listener = fn
        return () => undefined
      },
      status: () => ({ state }),
      runningGuest: () => {
        throw new Error('The workspace VM is not running')
      },
    } as unknown as VmController
    const renderer = new ChromeDesignRenderer({ vm })
    ;(renderer as unknown as { chromeProc: string }).chromeProc = 'proc_1'
    state = 'stopped'
    listener!({ state })
    await renderer.close()
    expect(renderer.available()).toBe(false)
  })
})
