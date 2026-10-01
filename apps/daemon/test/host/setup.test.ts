import { describe, expect, it } from 'vitest'

import { type HostProbe, hostSetup, kvmStatus } from '../../src/host/setup'

const GROUPS = 'root:x:0:\nkvm:x:993:ana,bia\ndocker:x:994:ana\n'

function probe(overrides: Partial<HostProbe> & { commands?: string[] } = {}): HostProbe {
  const commands = new Set(overrides.commands ?? ['apt-get'])
  return {
    platform: 'linux',
    arch: 'x64',
    hasCommand: (name) => commands.has(name),
    exists: (path) => path === '/dev/kvm',
    canReadWrite: () => true,
    groupFile: () => GROUPS,
    processGroups: () => [1000, 993],
    userName: () => 'ana',
    ...overrides,
  }
}

describe('hostSetup on Linux', () => {
  it('gives the install command of the distro and architecture', () => {
    expect(hostSetup(probe()).installCommand).toBe('sudo apt-get install -y qemu-system-x86 qemu-utils ovmf')
    expect(hostSetup(probe({ arch: 'arm64' })).installCommand).toBe(
      'sudo apt-get install -y qemu-system-arm qemu-utils qemu-efi-aarch64',
    )
    const dnf = hostSetup(probe({ commands: ['dnf'] }))
    expect(dnf.packageManager).toBe('dnf')
    expect(dnf.installCommand).toBe('sudo dnf install -y qemu-system-x86 qemu-img edk2-ovmf')
    expect(hostSetup(probe({ commands: ['pacman'] })).installCommand).toBe(
      'sudo pacman -S --needed qemu-system-x86 qemu-img edk2-ovmf',
    )
  })

  it('prefers apt when several package managers exist and has no command for unknown distros', () => {
    expect(hostSetup(probe({ commands: ['pacman', 'apt-get'] })).packageManager).toBe('apt')
    const unknown = hostSetup(probe({ commands: ['zypper'] }))
    expect(unknown).toMatchObject({ packageManager: null, installCommand: null })
  })

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
  it('keeps Homebrew on macOS and uses winget on Windows, without KVM checks', () => {
    expect(hostSetup(probe({ platform: 'darwin' }))).toEqual({
      packageManager: 'brew',
      installCommand: 'brew install qemu',
      kvm: null,
    })
    expect(hostSetup(probe({ platform: 'win32' }))).toMatchObject({ packageManager: 'winget', kvm: null })
  })
})
