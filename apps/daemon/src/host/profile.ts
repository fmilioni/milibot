import { homedir } from 'node:os'
import { dirname } from 'node:path'

import {
  type Host,
  type VmProfile,
  vmProfile,
  type VmProfileProbe,
  whpxSlowReason,
  whpxUsable,
  type WindowsHypervisorState,
} from '@milibot/shared'
import { kvmAvailable } from '@milibot/vm-host'

/** The running host, as the platform layer (`@milibot/shared` platform.ts) expects it. */
export function currentHost(env: NodeJS.ProcessEnv = process.env): Host {
  return { platform: process.platform, arch: process.arch, env, homedir: homedir() }
}

/**
 * `windowsHypervisor` (Windows, from `GET /host`'s probe): a state that rules WHPX out means TCG, with its reason;
 * without it (or `unknown`) WHPX is assumed.
 */
export function hostVmProfile(
  host: Host = currentHost(),
  qemuBinaryPath?: string | null,
  windowsHypervisor?: WindowsHypervisorState | null,
): VmProfile {
  const probe: VmProfileProbe = {}
  if (host.platform === 'linux') probe.accelAvailable = kvmAvailable()
  if (host.platform === 'win32') {
    probe.accelAvailable = whpxUsable(windowsHypervisor)
    const reason = whpxSlowReason(windowsHypervisor)
    if (reason) probe.slowReason = reason
  }
  if (host.env.MILIBOT_QEMU_SHARE) probe.qemuShare = host.env.MILIBOT_QEMU_SHARE
  if (qemuBinaryPath) probe.qemuDir = dirname(qemuBinaryPath)
  return vmProfile(host, probe)
}
