import fs from 'node:fs'
import path from 'node:path'

import {
  type GoldenFs,
  type Host,
  type VmProfile,
  vmProfile,
  type VmProfileProbe,
  type WhpxKernelIrqchip,
} from './shared.ts'

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function whichSync(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name)
  }
  return null
}

/** Linux: KVM needs `/dev/kvm` readable and writable (user in the `kvm` group). */
export function kvmAvailable(device = '/dev/kvm'): boolean {
  try {
    fs.accessSync(device, fs.constants.R_OK | fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Windows: the Hypervisor Platform feature installs WinHvPlatform.dll; without it WHPX cannot work. The
 * feature being on but no hypervisor running is only seen when QEMU fails (then `launchWithFallback`).
 */
function whpxDllPresent(): boolean {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
  return fs.existsSync(path.join(systemRoot, 'System32', 'WinHvPlatform.dll'))
}

/** Whether the accelerator is usable and where QEMU lives. Run after `process.env.PATH` is set. */
function probeHost(host: Host): VmProfileProbe {
  const probe: VmProfileProbe = {}
  if (host.env.MILIBOT_VM_ACCEL === 'tcg') probe.accelAvailable = false
  // MILIBOT_VM_ARCH emulates another guest architecture.
  else if (host.arch !== process.arch) probe.accelAvailable = false
  else if (host.platform === 'linux') probe.accelAvailable = kvmAvailable()
  else if (host.platform === 'win32') probe.accelAvailable = whpxDllPresent()
  if (host.env.MILIBOT_QEMU_SHARE) probe.qemuShare = host.env.MILIBOT_QEMU_SHARE
  const qemuPath = whichSync(vmProfile(host).qemuBinary)
  if (qemuPath) probe.qemuDir = path.dirname(qemuPath)
  return probe
}

export interface ProfileOverrides {
  tcg?: boolean
  whpxKernelIrqchip?: WhpxKernelIrqchip
}

export type HostProfile = (overrides?: ProfileOverrides) => VmProfile

/** The QEMU profile of this host, probed once on first use. `MILIBOT_VM_ACCEL=tcg` forces TCG. */
export function hostProfiles(host: Host, defaults: ProfileOverrides = {}): HostProfile {
  let probe: VmProfileProbe | null = null
  return (overrides = {}) => {
    probe ??= probeHost(host)
    const { tcg, whpxKernelIrqchip } = { ...defaults, ...overrides }
    const current = { ...probe }
    if (tcg) current.accelAvailable = false
    if (whpxKernelIrqchip) current.whpxKernelIrqchip = whpxKernelIrqchip
    return vmProfile(host, current)
  }
}

/** `GoldenFs` of `resolveGoldenFile` on the real filesystem. */
export const goldenFs: GoldenFs = {
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  exists: (file) => fs.existsSync(file),
}

export function writeAtomic(file: string, content: string | Uint8Array, mode?: number): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined)
  fs.renameSync(tmp, file)
}

/** Bytes a file takes on disk; Windows has no allocated-blocks count, so the apparent size stands in. */
export function actualBytes(file: string): number | null {
  try {
    const stat = fs.statSync(file)
    return process.platform === 'win32' || typeof stat.blocks !== 'number' ? stat.size : stat.blocks * 512
  } catch {
    return null
  }
}
