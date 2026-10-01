import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { VmCliDisk, VmCliPorts, VmCliStartResult, VmCliStatus, VmConfigFile } from '@milibot/shared'

import { type VmCli, VmCliError } from '../../src/vm-cli'

/** Emulates `vm/host`'s workspace-vm CLI: writes the files the controller reads, never runs QEMU. */
export class FakeVmCli implements VmCli {
  calls: string[][] = []
  failWith: { command: string; code: string } | null = null
  /** Fields replacing the defaults of the next `start` results, in order (e.g. WHPX irqchip reports). */
  startResults: Partial<VmCliStartResult>[] = []
  /** Called after each `start` wrote the pid (e.g. to write a qemu.log). */
  onStart: ((vmDir: string, args: string[]) => void) | null = null
  snapshots: Array<{ name: string; date: string }> = []
  restored: string[] = []

  async run(args: string[]): Promise<Record<string, unknown>> {
    this.calls.push(args)
    const [command, wsDir] = args as [string, string]
    if (this.failWith?.command === command) throw new VmCliError(this.failWith.code, `${command} failed`)
    const vmDir = join(wsDir, 'vm')
    const flag = (name: string) => args[args.indexOf(`--${name}`) + 1] as string
    switch (command) {
      case 'create': {
        mkdirSync(vmDir, { recursive: true })
        writeConfig(vmDir, {
          version: 1,
          name: flag('name'),
          hostname: `milibot-${flag('name')}`,
          instanceId: 'milibot-fake',
          cpus: Number(flag('cpus')),
          memGb: Number(flag('mem-gb')),
          dataGb: Number(flag('data-gb')),
          systemGb: Number(flag('system-gb')),
          portBase: Number(flag('port-base')),
          golden: flag('golden'),
          goldenVersion: null,
          macAddress: '52:54:00:00:00:01',
          createdAt: new Date(0).toISOString(),
          firmware: { code: '/fw/code.fd', vars: '/fw/vars.fd', codeSize: 1 },
        })
        writeFileSync(join(vmDir, 'agent.token'), 'fake-token\n')
        return { ok: true, created: true }
      }
      case 'start': {
        writeFileSync(join(vmDir, 'qemu.pid'), String(process.pid))
        this.onStart?.(vmDir, args)
        const result: VmCliStartResult = {
          ok: true,
          started: true,
          pid: process.pid,
          accel: 'hvf',
          accelArg: 'hvf',
          slow: false,
          reason: null,
          fallback: null,
          whpxKernelIrqchip: null,
          whpxKernelIrqchipForced: false,
          ports: ports(readConfig(vmDir).portBase),
          ...this.startResults.shift(),
        }
        return result
      }
      case 'stop':
        rmSync(join(vmDir, 'qemu.pid'), { force: true })
        return { ok: true, state: 'stopped', alreadyStopped: true }
      case 'reset-system': {
        const config = readConfig(vmDir)
        if (args.includes('--golden')) config.golden = flag('golden')
        writeConfig(vmDir, config)
        return { ok: true, reset: true }
      }
      case 'status': {
        const config = readConfig(vmDir)
        const running = existsSync(join(vmDir, 'qemu.pid'))
        const disk = (
          file: string,
          gb: number,
          snapshots: Array<{ name: string; date: string }> = [],
        ): VmCliDisk => ({
          path: join(vmDir, file),
          exists: true,
          virtualBytes: gb * GiB,
          actualBytes: Math.round(gb * GiB * 0.25),
          snapshots: snapshots.map((s, i) => ({ id: String(i + 1), ...s })),
        })
        const status: VmCliStatus = {
          ok: true,
          name: config.name,
          state: running ? 'running' : 'stopped',
          pid: running ? process.pid : null,
          qmpStatus: running ? 'running' : null,
          agentReachable: running,
          agentUrl: `http://127.0.0.1:${config.portBase}`,
          tokenFile: join(vmDir, 'agent.token'),
          ports: ports(config.portBase),
          cpus: config.cpus,
          memGb: config.memGb,
          golden: { path: config.golden, version: config.goldenVersion, exists: true },
          currentGolden: config.golden,
          running: null,
          accel: { kind: 'hvf', slow: false, reason: null },
          disks: {
            system: disk('system.qcow2', config.systemGb, this.snapshots),
            data: disk('data.qcow2', config.dataGb),
          },
          vmDir,
        }
        return status
      }
      case 'resize': {
        const config = readConfig(vmDir)
        if (args.includes('--cpus')) config.cpus = Number(flag('cpus'))
        if (args.includes('--mem-gb')) config.memGb = Number(flag('mem-gb'))
        writeConfig(vmDir, config)
        return { ok: true, cpus: config.cpus, memGb: config.memGb }
      }
      case 'grow-disk': {
        this.requireStopped(vmDir)
        const [, , disk, size] = args as [string, string, 'system' | 'data', string]
        const config = readConfig(vmDir)
        config[disk === 'system' ? 'systemGb' : 'dataGb'] = Number(size)
        writeConfig(vmDir, config)
        return { ok: true, disk, virtualBytes: Number(size) * GiB }
      }
      case 'snapshot': {
        const [, action, dir, name] = args as [string, string, string, string]
        this.requireStopped(join(dir, 'vm'))
        if (action === 'create')
          this.snapshots.push({ name, date: new Date(1_750_000_000_000).toISOString() })
        if (action === 'delete') this.snapshots = this.snapshots.filter((s) => s.name !== name)
        if (action === 'restore') this.restored.push(name)
        return { ok: true, action, name }
      }
      default:
        return { ok: true }
    }
  }

  private requireStopped(vmDir: string): void {
    if (existsSync(join(vmDir, 'qemu.pid'))) throw new VmCliError('VM_RUNNING', 'stop the VM first')
  }
}

const GiB = 1024 ** 3

function ports(portBase: number): VmCliPorts {
  return {
    agent: portBase,
    vncFirst: portBase + 1,
    vncLast: portBase + 50,
    vncForDisplay: 'portBase + display',
  }
}

function readConfig(vmDir: string): VmConfigFile {
  return JSON.parse(readFileSync(join(vmDir, 'config.json'), 'utf8')) as VmConfigFile
}

function writeConfig(vmDir: string, config: VmConfigFile): void {
  writeFileSync(join(vmDir, 'config.json'), JSON.stringify(config))
}
