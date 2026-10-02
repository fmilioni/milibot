import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import {
  bundledQemuHome,
  bundledQemuProgram,
  type Host,
  type VmProfile,
  vmProfile,
  type VmProfileProbe,
  whpxSlowReason,
  whpxUsable,
  type WindowsHypervisorState,
} from '@milibot/shared'
import { kvmAvailable } from '@milibot/vm-host'

import { defaultVmScript, vmRootDir } from '../vm-cli'

/** The running host, as the platform layer (`@milibot/shared` platform.ts) expects it. */
export function currentHost(env: NodeJS.ProcessEnv = process.env): Host {
  return { platform: process.platform, arch: process.arch, env, homedir: homedir() }
}

/**
 * The QEMU shipped with Milibot (`vm/bin/qemu` next to the VM scripts; `Resources/vm/bin/qemu` in the app) when
 * its emulator is there, else null (a system QEMU on the PATH is used).
 */
export function bundledQemu(
  host: Host = currentHost(),
  exists: (file: string) => boolean = existsSync,
): string | null {
  let vmRoot: string
  try {
    vmRoot = vmRootDir(defaultVmScript(host.env.MILIBOT_VM_CLI || null))
  } catch {
    return null
  }
  const home = bundledQemuHome(vmRoot, host.platform, host.env)
  return exists(bundledQemuProgram(home, vmProfile(host).qemuBinary, host.platform)) ? home : null
}

/**
 * `windowsHypervisor` (Windows, from `GET /host`'s probe): a state that rules WHPX out means TCG, with its reason;
 * without it (or `unknown`) WHPX is assumed. `qemuHome`: the bundled QEMU (`bundledQemu`), used instead of
 * `qemuBinaryPath` (a system QEMU).
 */
export function hostVmProfile(
  host: Host = currentHost(),
  qemuBinaryPath?: string | null,
  windowsHypervisor?: WindowsHypervisorState | null,
  qemuHome?: string | null,
): VmProfile {
  const probe: VmProfileProbe = {}
  if (host.platform === 'linux') probe.accelAvailable = kvmAvailable()
  if (host.platform === 'win32') {
    probe.accelAvailable = whpxUsable(windowsHypervisor)
    const reason = whpxSlowReason(windowsHypervisor)
    if (reason) probe.slowReason = reason
  }
  if (host.env.MILIBOT_QEMU_SHARE) probe.qemuShare = host.env.MILIBOT_QEMU_SHARE
  if (qemuHome) probe.qemuHome = qemuHome
  else if (qemuBinaryPath) probe.qemuDir = dirname(qemuBinaryPath)
  return vmProfile(host, probe)
}
