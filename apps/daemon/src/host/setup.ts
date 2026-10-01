import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'

import type { HostSetup, KvmStatus, PackageManager } from '@milibot/shared'

import { findExecutable } from './executables'

/** What the checks read from the host (injected: tests use fakes, never the real system). */
export interface HostProbe {
  platform: NodeJS.Platform
  /** `process.arch`: `x64`, `arm64`. */
  arch: string
  /** An executable with this name is on PATH (or in the usual system folders). */
  hasCommand(name: string): boolean
  exists(path: string): boolean
  /** Read and write access (what QEMU needs to open `/dev/kvm`). */
  canReadWrite(path: string): boolean
  /** `/etc/group`, or null when unreadable. */
  groupFile(): string | null
  /** Groups of the running process (`process.getgroups()`): the session's, not `/etc/group`'s. */
  processGroups(): number[]
  userName(): string
}

const LINUX_MANAGERS: { manager: PackageManager; command: string }[] = [
  { manager: 'apt', command: 'apt-get' },
  { manager: 'dnf', command: 'dnf' },
  { manager: 'pacman', command: 'pacman' },
]

/**
 * Packages with QEMU, `qemu-img` and the UEFI firmware the VM boots with, per distro family and
 * host architecture (x64 → `qemu-system-x86_64` + OVMF, arm64 → `qemu-system-aarch64` + AAVMF).
 */
function linuxInstallCommand(manager: PackageManager, arch: string): string | null {
  const arm = arch === 'arm64'
  switch (manager) {
    case 'apt':
      return arm
        ? 'sudo apt-get install -y qemu-system-arm qemu-utils qemu-efi-aarch64'
        : 'sudo apt-get install -y qemu-system-x86 qemu-utils ovmf'
    case 'dnf':
      return arm
        ? 'sudo dnf install -y qemu-system-aarch64 qemu-img edk2-aarch64'
        : 'sudo dnf install -y qemu-system-x86 qemu-img edk2-ovmf'
    case 'pacman':
      return arm
        ? 'sudo pacman -S --needed qemu-system-aarch64 qemu-img edk2-aarch64'
        : 'sudo pacman -S --needed qemu-system-x86 qemu-img edk2-ovmf'
    default:
      return null
  }
}

/** Members and gid of a group in `/etc/group` (`name:x:gid:user1,user2`). */
function parseGroup(file: string, name: string): { gid: number; members: string[] } | null {
  for (const line of file.split('\n')) {
    const [group, , gid, members] = line.split(':')
    if (group !== name || gid === undefined) continue
    return { gid: Number(gid), members: (members ?? '').split(',').filter(Boolean) }
  }
  return null
}

/**
 * Hardware acceleration on Linux: `/dev/kvm` must exist (virtualization on in the firmware, KVM
 * module loaded) and the user must be able to open it, usually through the `kvm` group. A user just
 * added to the group only gets it in a new session. Without KVM the VM runs under TCG (emulated, slow).
 */
export function kvmStatus(probe: HostProbe): KvmStatus {
  if (!probe.exists('/dev/kvm')) return 'no_device'
  if (probe.canReadWrite('/dev/kvm')) return 'ok'
  const file = probe.groupFile()
  const group = file ? parseGroup(file, 'kvm') : null
  if (group && group.members.includes(probe.userName()) && !probe.processGroups().includes(group.gid))
    return 'relogin'
  return 'no_permission'
}

/** What the setup shows to get QEMU (and KVM on Linux) ready on this computer. */
export function hostSetup(probe: HostProbe): HostSetup {
  if (probe.platform === 'darwin')
    return { packageManager: 'brew', installCommand: 'brew install qemu', kvm: null }
  if (probe.platform === 'win32')
    return {
      packageManager: 'winget',
      installCommand: 'winget install --id SoftwareFreedomConservancy.QEMU -e',
      kvm: null,
    }
  const found = LINUX_MANAGERS.find((m) => probe.hasCommand(m.command))
  const status = kvmStatus(probe)
  return {
    packageManager: found?.manager ?? null,
    installCommand: found ? linuxInstallCommand(found.manager, probe.arch) : null,
    kvm: {
      status,
      fixCommand: status === 'no_permission' ? 'sudo usermod -aG kvm "$USER"' : null,
    },
  }
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode)
    return true
  } catch {
    return false
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The real host, read-only: nothing here changes the system. */
export function systemHostProbe(): HostProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    hasCommand: (name) => findExecutable(name) !== null,
    exists: existsSync,
    canReadWrite: (path) => canAccess(path, constants.R_OK | constants.W_OK),
    groupFile: () => readText('/etc/group'),
    processGroups: () => process.getgroups?.() ?? [],
    userName: () => userInfo().username,
  }
}
