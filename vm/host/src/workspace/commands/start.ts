import fs from 'node:fs'

import { CliError, type Flags, intFlag } from '../../lib/args.ts'
import { sleep } from '../../lib/host.ts'
import { pidAlive } from '../../lib/proc.ts'
import {
  launchWithFallback,
  type VmCliStartOutput,
  type VmCliStartResult,
  VmLaunchExited,
  whpxIrqchipChoice,
} from '../../lib/shared.ts'
import { readConfig, writeConfig } from '../config.ts'
import type { VmHostContext } from '../context.ts'
import { pinnedFirmware } from '../firmware.ts'
import { vmPaths } from '../paths.ts'
import { agentPing, busyPorts, portsOf } from '../ports.ts'
import { launchQemu, readPid } from '../qemu-process.ts'
import { cmdStatus } from './status.ts'

export async function cmdStart(ctx: VmHostContext, wsDir: string, flags: Flags): Promise<VmCliStartOutput> {
  const p = vmPaths(wsDir)
  const config = readConfig(p)
  if (readPid(p)) return { ...(await cmdStatus(ctx, wsDir)), alreadyRunning: true }
  if (!fs.existsSync(config.golden))
    throw new CliError('GOLDEN_NOT_FOUND', `backing golden image missing: ${config.golden}`)
  for (const f of [p.system, p.data, p.vars, p.seed]) {
    if (!fs.existsSync(f)) throw new CliError('DISK_MISSING', `missing ${f}`)
  }
  const busy = await busyPorts(config.portBase, ctx.profile())
  if (busy.length) throw new CliError('PORT_IN_USE', `ports already in use: ${busy.join(', ')}`)

  const fw = pinnedFirmware(ctx, p, config)
  if (fs.existsSync(p.serial)) fs.renameSync(p.serial, `${p.serial}.1`)
  const irqchip = whpxIrqchipChoice(ctx.host.env, flags['whpx-kernel-irqchip'], config.whpxKernelIrqchip)
  let launched
  try {
    launched = await launchWithFallback({
      irqchip,
      profileFor: ctx.profile,
      launch: (prof) => launchQemu(p, config, fw, prof),
      beforeRetry: (fallback, log) => {
        // Keep the failed attempt's log next to the new one.
        fs.writeFileSync(`${p.qemuLog}.1`, log + '\n')
        process.stderr.write(`workspace-vm: qemu exited during startup; retrying (${fallback})\n`)
      },
    })
  } catch (err) {
    if (err instanceof VmLaunchExited) throw new CliError('START_FAILED', err.message)
    throw err
  }
  const { child, started } = launched.result
  const used = launched.profile
  const whpx = used.accelKind === 'whpx'
  // An irqchip fallback or an explicit `--whpx-kernel-irqchip` sticks to this VM; the env override is never saved.
  if (whpx && !irqchip.forced && launched.whpxKernelIrqchip !== 'default') {
    config.whpxKernelIrqchip = launched.whpxKernelIrqchip
  }
  // What the running VM got (resize only applies on the next boot); read by the daemon instead of `ps`.
  const running = {
    pid: readPid(p) ?? child.pid ?? 0,
    cpus: config.cpus,
    memGb: config.memGb,
    accel: used.accelKind,
    accelArg: used.accel,
    startedAt: new Date(started).toISOString(),
  }
  config.running = running
  writeConfig(p, config)

  const result: VmCliStartResult = {
    ok: true,
    started: true,
    pid: running.pid,
    accel: used.accelKind,
    accelArg: used.accel,
    slow: used.slow,
    reason: used.slowReason,
    fallback: launched.fallback,
    whpxKernelIrqchip: whpx ? launched.whpxKernelIrqchip : null,
    whpxKernelIrqchipForced: whpx && irqchip.forced,
    ports: portsOf(config),
  }
  if (flags.wait) {
    const timeoutSec = intFlag(flags, 'timeout-sec', { fallback: 180 })
    const waitDeadline = Date.now() + timeoutSec * 1000
    while (!(await agentPing(config.portBase))) {
      if (!pidAlive(running.pid)) throw new CliError('VM_DIED', 'VM exited during boot (see serial.log)')
      if (Date.now() > waitDeadline)
        throw new CliError('BOOT_TIMEOUT', `guest agent not reachable after ${timeoutSec}s`)
      await sleep(500)
    }
    result.agentReady = true
    result.bootMs = Date.now() - started
  }
  return result
}
