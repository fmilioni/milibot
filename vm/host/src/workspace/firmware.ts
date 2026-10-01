import fs from 'node:fs'

import { CliError } from '../lib/args.ts'
import type { FirmwarePair, VmConfigFile, VmSavedFirmware } from '../lib/shared.ts'
import { writeConfig } from './config.ts'
import type { VmHostContext } from './context.ts'
import type { VmPaths } from './paths.ts'

export interface FirmwareChoice {
  pair: FirmwarePair
  codeSize: number
  /** The saved pair changed, so the VM's vars copy no longer matches its code. */
  recreateVars: boolean
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

/**
 * The VM's firmware: the pair saved in config.json while its code file is still there with the same size,
 * else the first installed candidate (a new VM has none saved).
 */
export function chooseFirmware(
  saved: VmSavedFirmware | undefined,
  candidates: FirmwarePair[],
  sizeOf: (file: string) => number | null,
): FirmwareChoice | null {
  if (saved && sizeOf(saved.code) === saved.codeSize) {
    return { pair: { code: saved.code, vars: saved.vars }, codeSize: saved.codeSize, recreateVars: false }
  }
  for (const pair of candidates) {
    const codeSize = sizeOf(pair.code)
    if (codeSize === null || sizeOf(pair.vars) === null) continue
    return { pair: { code: pair.code, vars: pair.vars }, codeSize, recreateVars: Boolean(saved) }
  }
  return null
}

export function firmware(ctx: VmHostContext, saved?: VmSavedFirmware): FirmwareChoice {
  const candidates = ctx.profile().firmware
  const chosen = chooseFirmware(saved, candidates, fileSize)
  if (!chosen) {
    throw new CliError(
      'FIRMWARE_NOT_FOUND',
      `UEFI firmware not found (tried ${candidates.map((c) => c.code).join(', ')})`,
    )
  }
  return chosen
}

export function copyVarsTemplate(template: string, dest: string): void {
  fs.copyFileSync(template, dest, fs.constants.COPYFILE_FICLONE)
  // Distro templates can be read-only (e.g. 0444); the VM's copy must be writable.
  fs.chmodSync(dest, 0o600)
}

/** Pins the firmware in config.json; a pinned pair that changed (distro upgrade) gets a fresh vars copy. */
export function pinnedFirmware(ctx: VmHostContext, p: VmPaths, config: VmConfigFile): FirmwarePair {
  const { pair, codeSize, recreateVars } = firmware(ctx, config.firmware)
  if (recreateVars) copyVarsTemplate(pair.vars, p.vars)
  if (config.firmware.code !== pair.code || config.firmware.codeSize !== codeSize) {
    config.firmware = { ...pair, codeSize }
    writeConfig(p, config)
  }
  return pair
}
