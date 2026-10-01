import { type Flags, intFlag } from '../../lib/args.ts'
import type { VmCliStopResult } from '../../lib/shared.ts'
import { readConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { vmPaths } from '../paths.ts'
import { stopVm } from '../qemu-process.ts'

export function cmdStop(ctx: VmHostContext, wsDir: string, flags: Flags): Promise<VmCliStopResult> {
  const p = vmPaths(wsDir)
  return stopVm(ctx, p, readConfig(p), {
    timeoutSec: intFlag(flags, 'timeout-sec', { fallback: 60 }),
    force: flags.force === true,
  })
}
