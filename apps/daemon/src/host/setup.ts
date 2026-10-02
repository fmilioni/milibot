import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'

import type { HostSetup, KvmStatus } from '@milibot/shared'

/** What the checks read from the host (injected: tests use fakes, never the real system). */
export interface HostProbe {
  platform: NodeJS.Platform
  exists(path: string): boolean
  /** Read and write access (what QEMU needs to open `/dev/kvm`). */
  canReadWrite(path: string): boolean
  /** `/etc/group`, or null when unreadable. */
  groupFile(): string | null
  /** Groups of the running process (`process.getgroups()`): the session's, not `/etc/group`'s. */
  processGroups(): number[]
  userName(): string
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

/** What the setup shows about this host: KVM on Linux (QEMU itself ships with the app). */
export function hostSetup(probe: HostProbe): HostSetup {
  if (probe.platform !== 'linux') return { kvm: null }
  const status = kvmStatus(probe)
  return { kvm: { status, fixCommand: status === 'no_permission' ? 'sudo usermod -aG kvm "$USER"' : null } }
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
    exists: existsSync,
    canReadWrite: (path) => canAccess(path, constants.R_OK | constants.W_OK),
    groupFile: () => readText('/etc/group'),
    processGroups: () => process.getgroups?.() ?? [],
    userName: () => userInfo().username,
  }
}
