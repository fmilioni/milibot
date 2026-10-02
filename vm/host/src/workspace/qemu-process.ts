import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'

import { CliError } from '../lib/args.ts'
import { startGvproxy, stopGvproxy } from '../lib/gvproxy.ts'
import { sleep } from '../lib/host.ts'
import { pidAlive, qemuIdentity, readPidFile } from '../lib/proc.ts'
import { baseQemuArgs } from '../lib/qemu.ts'
import {
  type FirmwarePair,
  GUEST_AGENT_PORT,
  NET_TCP_OFFSET,
  type VmCliStopResult,
  type VmConfigFile,
  VmLaunchExited,
  type VmProfile,
  VNC_DISPLAYS,
  VNC_PORT_BASE,
} from '../lib/shared.ts'
import { clearRunning } from './config.ts'
import type { VmHostContext } from './context.ts'
import type { VmPaths } from './paths.ts'
import { qmp, qmpArg, qmpEndpoint, qmpReachable } from './qmp.ts'

/** QEMU's pid; a pid file left by a QEMU that died with the host (the pid may be reused) is removed. */
export function readPid(p: VmPaths): number | null {
  const pid = readPidFile(p.pid)
  if (!pid) return null
  if (qemuIdentity(pid) === 'no') {
    fs.rmSync(p.pid, { force: true })
    return null
  }
  return pid
}

export function requireStopped(p: VmPaths): void {
  if (readPid(p)) throw new CliError('VM_RUNNING', 'stop the VM first')
}

export function qemuArgs(
  p: Pick<VmPaths, 'system' | 'data' | 'vars' | 'seed' | 'serial' | 'pid'>,
  config: Pick<VmConfigFile, 'name' | 'cpus' | 'memGb' | 'portBase' | 'macAddress'>,
  fw: Pick<FirmwarePair, 'code'>,
  prof: VmProfile,
): string[] {
  return [
    ...baseQemuArgs(prof, fw, {
      name: `milibot-${config.name}`,
      cpus: config.cpus,
      memGb: config.memGb,
      vars: p.vars,
      disks: [
        { id: 'sys', file: p.system, serial: 'milisys' },
        { id: 'data', file: p.data, serial: 'milidata' },
      ],
      seed: p.seed,
      netPort: config.portBase + NET_TCP_OFFSET,
      mac: config.macAddress,
      serial: p.serial,
    }),
    '-qmp',
    qmpArg(prof, config),
    '-pidfile',
    p.pid,
  ]
}

/** Host ports gvproxy forwards: the agent at the port base, display N's VNC at `portBase + N`. */
export function vmForwards(portBase: number): [number, number][] {
  const forwards: [number, number][] = [[portBase, GUEST_AGENT_PORT]]
  for (let d = 1; d <= VNC_DISPLAYS; d++) forwards.push([portBase + d, VNC_PORT_BASE + d])
  return forwards
}

export interface LaunchedQemu {
  child: ChildProcess
  started: number
}

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null } | { error: string }

/**
 * Starts the VM's gvproxy, spawns QEMU and waits until the pid file exists and QMP answers. A QEMU that
 * exits meanwhile rejects with `VmLaunchExited` (its log tail), so `launchWithFallback` can retry with TCG
 * or `kernel-irqchip=off`; gvproxy is stopped on any failure.
 */
export async function launchQemu(
  ctx: VmHostContext,
  p: VmPaths,
  config: VmConfigFile,
  fw: FirmwarePair,
  prof: VmProfile,
): Promise<LaunchedQemu> {
  await startGvproxy(ctx.gvproxy, p.net, {
    qemuPort: config.portBase + NET_TCP_OFFSET,
    mac: config.macAddress,
    forwards: vmForwards(config.portBase),
  })
  try {
    return await spawnQemu(p, config, fw, prof)
  } catch (err) {
    await stopGvproxy(p.net)
    throw err
  }
}

async function spawnQemu(
  p: VmPaths,
  config: VmConfigFile,
  fw: FirmwarePair,
  prof: VmProfile,
): Promise<LaunchedQemu> {
  for (const f of [p.qmp, p.pid]) fs.rmSync(f, { force: true })
  const logFd = fs.openSync(p.qemuLog, 'w')
  const started = Date.now()
  const child = spawn(prof.qemuBinary, qemuArgs(p, config, fw, prof), {
    cwd: p.vm,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
    windowsHide: true,
  })
  fs.closeSync(logFd)
  let exited: ExitInfo | null = null
  child.on('exit', (code, signal) => (exited = { code, signal }))
  child.on('error', (err: NodeJS.ErrnoException) => {
    exited = { error: err.code === 'ENOENT' ? `${prof.qemuBinary} not found` : err.message }
  })
  child.unref()

  const deadline = Date.now() + 15_000
  while (!fs.existsSync(p.pid) || !(await qmpReachable(qmpEndpoint(prof, config)))) {
    if (exited || Date.now() > deadline) {
      const log = fs.existsSync(p.qemuLog)
        ? fs.readFileSync(p.qemuLog, 'utf8').trim().split('\n').slice(-10).join('\n')
        : ''
      const message = `qemu failed to start: ${log || JSON.stringify(exited)}`
      if (!exited) {
        child.kill('SIGKILL')
        throw new CliError('START_FAILED', message)
      }
      throw new VmLaunchExited(message, log)
    }
    await sleep(100)
  }
  return { child, started }
}

/** ACPI power-down, then QMP `quit`, then SIGKILL (only for a pid confirmed to be QEMU). */
export async function stopVm(
  ctx: VmHostContext,
  p: VmPaths,
  config: VmConfigFile,
  { timeoutSec = 60, force = false }: { timeoutSec?: number; force?: boolean } = {},
): Promise<VmCliStopResult> {
  const pid = readPid(p)
  if (!pid) {
    await stopGvproxy(p.net)
    clearRunning(p)
    return { ok: true, state: 'stopped', alreadyStopped: true }
  }
  const endpoint = qmpEndpoint(ctx.profile(), config)
  const started = Date.now()
  let method: 'acpi' | 'kill' | 'quit' | 'timeout-quit' | 'sigkill' = 'acpi'
  if (!force) {
    try {
      await qmp(endpoint, [{ execute: 'system_powerdown' }])
    } catch {
      method = 'kill'
    }
    const deadline = Date.now() + timeoutSec * 1000
    while (pidAlive(pid) && Date.now() < deadline && method === 'acpi') await sleep(250)
  }
  if (pidAlive(pid)) {
    method = force ? 'quit' : 'timeout-quit'
    try {
      await qmp(endpoint, [{ execute: 'quit' }], 3000)
    } catch {
      // Falls through to signals.
    }
    const deadline = Date.now() + 5000
    while (pidAlive(pid) && Date.now() < deadline) await sleep(100)
  }
  if (pidAlive(pid)) {
    if (qemuIdentity(pid) !== 'yes')
      throw new CliError('STOP_FAILED', `pid ${pid} could not be confirmed as QEMU; not killing it`)
    method = 'sigkill'
    process.kill(pid, 'SIGKILL')
    while (pidAlive(pid)) await sleep(100)
  }
  for (const f of [p.qmp, p.pid]) fs.rmSync(f, { force: true })
  await stopGvproxy(p.net)
  clearRunning(p)
  return { ok: true, state: 'stopped', method, stopMs: Date.now() - started }
}
