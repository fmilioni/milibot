import fs from 'node:fs'

import { type Flags, intFlag, stringFlag } from '../../lib/args.ts'
import type { VmCliResetResult } from '../../lib/shared.ts'
import { readConfig, writeConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { goldenVersion, resolveGolden } from '../golden.ts'
import { vmPaths } from '../paths.ts'
import { qemuImg } from '../qemu-img.ts'
import { stopVm } from '../qemu-process.ts'

/** Recreates the system overlay on the given (or current) golden image; the data disk is kept. */
export async function cmdResetSystem(
  ctx: VmHostContext,
  wsDir: string,
  flags: Flags,
): Promise<VmCliResetResult> {
  const p = vmPaths(wsDir)
  const stop = await stopVm(ctx, p, readConfig(p), {
    timeoutSec: intFlag(flags, 'timeout-sec', { fallback: 60 }),
  })
  const config = readConfig(p)
  const golden = resolveGolden(ctx, stringFlag(flags, 'golden'))
  const tmp = `${p.system}.new`
  fs.rmSync(tmp, { force: true })
  await qemuImg(ctx, 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', golden, tmp, `${config.systemGb}G`)
  fs.renameSync(tmp, p.system)
  const previous = config.golden
  config.golden = golden
  config.goldenVersion = goldenVersion(golden)
  config.systemResetAt = new Date().toISOString()
  writeConfig(p, config)
  return {
    ok: true,
    reset: true,
    stoppedFirst: !('alreadyStopped' in stop),
    golden,
    previousGolden: previous,
  }
}
