import { describe, expect, it } from 'vitest'

import { vmRootDir } from '../src/vm-cli'

describe('vmRootDir', () => {
  it('finds the vm/ folder of a VM script', () => {
    expect(vmRootDir('/r/vm/host/src/cli/workspace-vm.ts')).toBe('/r/vm')
    expect(vmRootDir('/r/vm/scripts/workspace-vm.mjs')).toBe('/r/vm')
    expect(vmRootDir('/r/vm/workspace-vm.sh')).toBe('/r/vm')
  })
})
