import { describe, expect, it } from 'vitest'

import { computerCapabilities, ComputerChoice, SetupComputerBody } from './computer'

describe('computer choices', () => {
  const size = { cpus: 2, memGb: 4, dataGb: 40 }

  it('take no computer, or a VM with or without a size when switching', () => {
    expect(ComputerChoice.parse({ kind: 'none' })).toEqual({ kind: 'none' })
    expect(ComputerChoice.parse({ kind: 'vm' })).toEqual({ kind: 'vm' })
    expect(ComputerChoice.parse({ kind: 'vm', size })).toEqual({ kind: 'vm', size })
  })

  it('require the size of the VM the setup creates', () => {
    expect(SetupComputerBody.safeParse({ kind: 'vm' }).success).toBe(false)
    expect(SetupComputerBody.parse({ kind: 'vm', size })).toEqual({ kind: 'vm', size })
    expect(SetupComputerBody.parse({ kind: 'none' })).toEqual({ kind: 'none' })
  })

  it('refuse unknown kinds and sizes out of bounds', () => {
    expect(ComputerChoice.safeParse({ kind: 'mainframe' }).success).toBe(false)
    expect(ComputerChoice.safeParse({ kind: 'vm', size: { ...size, dataGb: 10 } }).success).toBe(false)
  })
})

describe('computerCapabilities', () => {
  it('gives the VM every capability and no computer none', () => {
    expect([...computerCapabilities('vm')]).toEqual(['shell', 'desktop', 'browser', 'documents'])
    expect(computerCapabilities('none').size).toBe(0)
  })
})
