import { CliError, usage } from '../../lib/args.ts'
import type { VmCliGrowDiskResult } from '../../lib/shared.ts'
import { readConfig, writeConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { vmPaths } from '../paths.ts'
import { imageInfo, qemuImg } from '../qemu-img.ts'
import { requireStopped } from '../qemu-process.ts'

const GiB = 1024 ** 3

export const GROW_DISK_USAGE = 'grow-disk <wsDir> system|data <newGB>'

export async function cmdGrowDisk(
  ctx: VmHostContext,
  wsDir: string,
  which: string,
  sizeArg: string,
): Promise<VmCliGrowDiskResult> {
  const p = vmPaths(wsDir)
  const config = readConfig(p)
  if (which !== 'system' && which !== 'data') throw usage(GROW_DISK_USAGE)
  const newGb = Number(sizeArg)
  if (!Number.isInteger(newGb) || newGb < 1 || newGb > 4096) throw usage('newGB must be an integer')
  requireStopped(p)
  const file = which === 'system' ? p.system : p.data
  const current = (await imageInfo(ctx, file))['virtual-size']
  const target = newGb * GiB
  if (target < current)
    throw new CliError('CANNOT_SHRINK', `disk is ${current / GiB}G; shrinking is not supported`)
  if (target > current) await qemuImg(ctx, 'resize', '-q', file, `${newGb}G`)
  if (which === 'system') config.systemGb = newGb
  else config.dataGb = newGb
  writeConfig(p, config)
  return { ok: true, disk: which, previousBytes: current, virtualBytes: target, changed: target > current }
}
