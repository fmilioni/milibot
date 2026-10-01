import { describe, expect, it } from 'vitest'

import { hostLimits } from '../../src/host/info'

describe('hostLimits', () => {
  it('derives the VM limits from the host', () => {
    expect(hostLimits(18, 36 * 1024 ** 3)).toEqual({
      cpus: 18,
      memoryGb: 36,
      maxVmCpus: 16,
      maxVmMemoryGb: 28,
    })
    expect(hostLimits(2, 8 * 1024 ** 3)).toMatchObject({ maxVmCpus: 1, maxVmMemoryGb: 2 })
  })
})
