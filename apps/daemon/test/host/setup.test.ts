import { describe, expect, it } from 'vitest'

import { type HostProbe, hostSetup, kvmStatus } from '../../src/host/setup'

const GROUPS = 'root:x:0:\nkvm:x:993:ana,bia\ndocker:x:994:ana\n'

function probe(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    platform: 'linux',
    exists: (path) => path === '/dev/kvm',
    canReadWrite: () => true,
    groupFile: () => GROUPS,
    processGroups: () => [1000, 993],
    userName: () => 'ana',
    ...overrides,
  }
}

describe('hostSetup on Linux', () => {
  it('reports KVM ready when /dev/kvm opens', () => {
    expect(hostSetup(probe()).kvm).toEqual({ status: 'ok', fixCommand: null })
  })

  it('asks to join the kvm group when the device is there but not accessible', () => {
    const setup = hostSetup(probe({ canReadWrite: () => false, userName: () => 'caio' }))
    expect(setup.kvm).toEqual({ status: 'no_permission', fixCommand: 'sudo usermod -aG kvm "$USER"' })
  })

  it('asks to log in again when the user joined the group after the session started', () => {
    const setup = hostSetup(probe({ canReadWrite: () => false, processGroups: () => [1000] }))
    expect(setup.kvm).toEqual({ status: 'relogin', fixCommand: null })
  })

  it('warns when there is no /dev/kvm (the VM would run emulated)', () => {
    expect(kvmStatus(probe({ exists: () => false }))).toBe('no_device')
    expect(kvmStatus(probe({ canReadWrite: () => false, groupFile: () => null }))).toBe('no_permission')
  })
})

describe('hostSetup on macOS and Windows', () => {
  it('has nothing to check (QEMU ships with the app)', () => {
    expect(hostSetup(probe({ platform: 'darwin' }))).toEqual({ kvm: null })
    expect(hostSetup(probe({ platform: 'win32' }))).toEqual({ kvm: null })
  })
})
