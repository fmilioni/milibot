import { type Flags, intFlag, usage } from '../../lib/args.ts'
import type { VmCliResizeResult } from '../../lib/shared.ts'
import { readConfig, writeConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { vmPaths } from '../paths.ts'
import { maxPortBase, MIN_PORT_BASE, portsOf } from '../ports.ts'
import { readPid, requireStopped } from '../qemu-process.ts'

export async function cmdResize(ctx: VmHostContext, wsDir: string, flags: Flags): Promise<VmCliResizeResult> {
  const p = vmPaths(wsDir)
  const config = readConfig(p)
  if (flags.cpus === undefined && flags['mem-gb'] === undefined && flags['port-base'] === undefined) {
    throw usage('resize needs --cpus, --mem-gb and/or --port-base')
  }
  if (flags.cpus !== undefined) config.cpus = intFlag(flags, 'cpus', { max: 64 })
  if (flags['mem-gb'] !== undefined) config.memGb = intFlag(flags, 'mem-gb', { max: 512 })
  if (flags['port-base'] !== undefined) {
    // The running QEMU keeps forwarding the old ports.
    requireStopped(p)
    config.portBase = intFlag(flags, 'port-base', { min: MIN_PORT_BASE, max: maxPortBase(ctx.profile()) })
  }
  writeConfig(p, config)
  return {
    ok: true,
    cpus: config.cpus,
    memGb: config.memGb,
    portBase: config.portBase,
    ports: portsOf(config),
    appliesOnNextBoot: true,
    running: Boolean(readPid(p)),
  }
}
