import { describe, expect, it } from 'vitest'

import { runningResources } from '../../../src/runtime/vm/controller'

describe('runningResources', () => {
  it('reads the resources of the running QEMU from its config.json record', () => {
    const running = { pid: 42, cpus: 6, memGb: 12 }
    expect(runningResources(running, 42)).toEqual({ cpus: 6, memGb: 12 })
    // A record left by a previous QEMU (other pid) or no live VM says nothing.
    expect(runningResources(running, 43)).toBeNull()
    expect(runningResources(running, null)).toBeNull()
    expect(runningResources(undefined, 42)).toBeNull()
  })
})
