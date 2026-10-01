import { existsSync, realpathSync, statSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'

import { type Host, type HostInfo, type WindowsHypervisorState } from '@milibot/shared'

import { goldenVersionOf } from '../golden/revision'
import { findExecutable } from './executables'
import { currentHost, hostVmProfile } from './profile'

const GiB = 1024 ** 3

/** VM limits from the host: vCPUs up to cores − 2, memory up to total − 8 GB. */
export function hostLimits(cores: number, memoryBytes: number): Omit<HostInfo, 'goldenImage' | 'qemu'> {
  const memoryGb = Math.round(memoryBytes / GiB)
  return {
    cpus: cores,
    memoryGb,
    maxVmCpus: Math.max(1, cores - 2),
    maxVmMemoryGb: Math.max(2, memoryGb - 8),
  }
}

/** `windowsHypervisor` only on Windows (the async probe runs in the route); it shapes `vmAccel`. */
export function hostInfo(goldenLink: string | null, windowsHypervisor?: WindowsHypervisorState): HostInfo {
  let goldenImage: HostInfo['goldenImage'] = null
  if (goldenLink && existsSync(goldenLink)) {
    goldenImage = { bytes: diskBytes(realpathSync(goldenLink)) ?? 0, version: goldenVersionOf(goldenLink) }
  }
  return {
    ...hostLimits(cpus().length, totalmem()),
    goldenImage,
    qemu: qemuStatus(),
    ...vmAccelInfo(process.env, windowsHypervisor),
  }
}

/** Space a (sparse) file really takes; Windows has no `blocks`, so the apparent size stands in. */
export function diskBytes(file: string): number | null {
  try {
    const stat = statSync(file)
    return process.platform === 'win32' || typeof stat.blocks !== 'number' ? stat.size : stat.blocks * 512
  } catch {
    return null
  }
}

/**
 * Checked on every call, so "check again" after installing QEMU sees it without a restart. On Windows
 * `%ProgramFiles%\qemu` is searched too: winget installs QEMU there without adding it to the PATH. QEMU only
 * counts as found with the UEFI firmware too (Linux packages it separately: `ovmf`, `qemu-efi-aarch64`).
 */
export function qemuStatus(
  env: NodeJS.ProcessEnv = process.env,
  host: Host = currentHost(env),
  isFile?: (file: string, platform: string) => boolean,
  fileExists: (file: string) => boolean = existsSync,
): HostInfo['qemu'] {
  const { qemuBinary, qemuImgBinary } = hostVmProfile(host)
  const system = findExecutable(qemuBinary, env, host, isFile)
  const img = findExecutable(qemuImgBinary, env, host, isFile)
  const candidates = hostVmProfile(host, system).firmware
  const firmware = candidates.some((pair) => fileExists(pair.code) && fileExists(pair.vars))
  return {
    found: Boolean(system && img && firmware),
    path: system ?? null,
    binary: qemuBinary,
    firmware: { found: firmware, tried: candidates.map((pair) => pair.code) },
  }
}

/** Platform and accelerator the next VM boot will use (TCG = slow, shown as a warning). */
export function vmAccelInfo(
  env: NodeJS.ProcessEnv = process.env,
  windowsHypervisor?: WindowsHypervisorState | null,
  host: Host = currentHost(env),
): Pick<HostInfo, 'platform' | 'vmAccel'> {
  const profile = hostVmProfile(host, null, windowsHypervisor)
  return {
    platform: { os: host.platform, arch: host.arch },
    vmAccel: {
      kind: profile.accelKind,
      preferred: profile.preferredAccel,
      slow: profile.slow,
      reason: profile.slowReason,
    },
  }
}
