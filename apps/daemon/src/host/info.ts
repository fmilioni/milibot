import { existsSync, realpathSync, statSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'

import { executableName, type Host, type HostInfo, type WindowsHypervisorState } from '@milibot/shared'

import { goldenVersionOf } from '../golden/revision'
import { findExecutable } from './executables'
import { bundledQemu, currentHost, hostVmProfile } from './profile'

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
 * Checked on every call. The QEMU shipped with Milibot (`qemuHome`) counts when its emulator, `qemu-img` and
 * firmware are there; without it a system QEMU is looked for on the PATH (on Windows also
 * `%ProgramFiles%\\qemu`, where winget installs it), with the UEFI firmware too (Linux packages it separately:
 * `ovmf`, `qemu-efi-aarch64`).
 */
export function qemuStatus(
  env: NodeJS.ProcessEnv = process.env,
  host: Host = currentHost(env),
  isFile?: (file: string, platform: string) => boolean,
  fileExists: (file: string) => boolean = existsSync,
  qemuHome: string | null = bundledQemu(host),
): HostInfo['qemu'] {
  const binary = executableName(hostVmProfile(host).qemuBinary, host.platform)
  let system: string | null
  let img: string | null
  let candidates
  if (qemuHome) {
    const bundled = hostVmProfile(host, null, null, qemuHome)
    system = fileExists(bundled.qemuBinary) ? bundled.qemuBinary : null
    img = fileExists(bundled.qemuImgBinary) ? bundled.qemuImgBinary : null
    candidates = bundled.firmware
  } else {
    const { qemuBinary, qemuImgBinary } = hostVmProfile(host)
    system = findExecutable(qemuBinary, env, host, isFile)
    img = findExecutable(qemuImgBinary, env, host, isFile)
    candidates = hostVmProfile(host, system).firmware
  }
  const firmware = candidates.some((pair) => fileExists(pair.code) && fileExists(pair.vars))
  return {
    found: Boolean(system && img && firmware),
    path: system ?? null,
    binary,
    firmware: { found: firmware, tried: candidates.map((pair) => pair.code) },
  }
}

/** `qemu-img` of the bundled QEMU, else the PATH's (backups). */
export function findQemuImg(
  host: Host = currentHost(),
  qemuHome: string | null = bundledQemu(host),
): string | null {
  return qemuHome
    ? hostVmProfile(host, null, null, qemuHome).qemuImgBinary
    : findExecutable('qemu-img', host.env)
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
