import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  VmCliCreateResult,
  VmCliErrorBody,
  VmCliGrowDiskResult,
  VmCliResetResult,
  VmCliResizeResult,
  VmCliSnapshotResult,
  VmCliStartOutput,
  VmCliStartResult,
  VmCliStatus,
  VmCliStopResult,
  VmConfigFile,
  VmConfigFileView,
} from '../../../packages/shared/src/vm/vm-cli.ts'
import { gvproxyIdentity, pidAlive, qemuIdentity } from '../src/lib/proc.ts'
import { type FakeQemuHost, fakeQemuHost } from './support/fake-qemu.ts'

const execFileAsync = promisify(execFile)
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli/workspace-vm.ts')

describe.skipIf(process.platform === 'win32')('workspace-vm commands (fake QEMU)', () => {
  let root = ''
  let fake: FakeQemuHost
  let ws = ''
  const portBase = 30_000 + Math.floor(Math.random() * 300) * 100

  async function run(...args: string[]): Promise<{ code: number; json: unknown }> {
    try {
      const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
        env: fake.env,
        windowsHide: true,
      })
      return { code: 0, json: JSON.parse(stdout) }
    } catch (err) {
      const e = err as { code?: number; stdout?: string }
      return { code: e.code ?? -1, json: e.stdout ? JSON.parse(e.stdout) : null }
    }
  }

  async function ok<T>(schema: { parse: (v: unknown) => T }, ...args: string[]): Promise<T> {
    const { code, json } = await run(...args)
    expect(json, JSON.stringify(json)).not.toMatchObject({ ok: false })
    expect(code).toBe(0)
    return schema.parse(json)
  }

  async function fails(code: string, exitCode: number, ...args: string[]): Promise<void> {
    const result = await run(...args)
    expect(result.code).toBe(exitCode)
    expect(VmCliErrorBody.parse(result.json).error.code).toBe(code)
  }

  const gvproxyPid = () => Number(fs.readFileSync(path.join(ws, 'vm', 'gvproxy.pid'), 'utf8'))

  const config = () =>
    VmConfigFile.parse(JSON.parse(fs.readFileSync(path.join(ws, 'vm', 'config.json'), 'utf8')))

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'milibot-vm-host-'))
    fake = fakeQemuHost(root)
    ws = path.join(root, 'ws')
  })

  afterAll(async () => {
    if (ws && fs.existsSync(path.join(ws, 'vm', 'config.json'))) await run('stop', ws, '--force')
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates the VM files and refuses a second create or a port range past 65535', async () => {
    await fails('USAGE', 2, 'create', ws, '--port-base', '65500')
    const created = await ok(
      VmCliCreateResult,
      'create',
      ws,
      '--port-base',
      String(portBase),
      '--name',
      'Demo WS',
      '--cpus',
      '2',
      '--mem-gb=4',
      '--golden',
      fake.golden,
    )
    expect(created.config).toMatchObject({ name: 'demo-ws', hostname: 'milibot-demo-ws', cpus: 2, memGb: 4 })
    expect(created.config.golden).toBe(fs.realpathSync(fake.golden))
    expect(created.config.goldenVersion).toBe('202609300000')
    expect(created.config.firmware.codeSize).toBe(4096)
    for (const file of ['system.qcow2', 'data.qcow2', 'efi-vars.fd', 'seed.iso', 'agent.token'])
      expect(fs.existsSync(path.join(ws, 'vm', file)), file).toBe(true)
    expect(fs.statSync(path.join(ws, 'vm', 'agent.token')).mode & 0o777).toBe(0o600)
    expect(VmConfigFileView.parse(config())).toMatchObject({ cpus: 2, memGb: 4, dataGb: 60, systemGb: 40 })
    await fails('VM_EXISTS', 1, 'create', ws, '--port-base', String(portBase))
  })

  it('reports a stopped VM and manages restore points', async () => {
    const status = await ok(VmCliStatus, 'status', ws)
    expect(status).toMatchObject({ state: 'stopped', pid: null, running: null, agentReachable: false })
    expect(status.disks.system).toMatchObject({ exists: true, virtualBytes: 40 * 1024 ** 3 })

    const created = await ok(VmCliSnapshotResult, 'snapshot', 'create', ws, 'before')
    expect(created.snapshots.map((s) => s.name)).toEqual(['before'])
    await fails('SNAPSHOT_EXISTS', 1, 'snapshot', 'create', ws, 'before')
    await fails('USAGE', 2, 'snapshot', 'create', ws, 'bad name')
    await ok(VmCliSnapshotResult, 'snapshot', 'restore', ws, 'before')
    await ok(VmCliSnapshotResult, 'snapshot', 'delete', ws, 'before')
    await fails('SNAPSHOT_NOT_FOUND', 1, 'snapshot', 'restore', ws, 'before')
    expect((await ok(VmCliSnapshotResult, 'snapshot', 'list', ws)).snapshots).toEqual([])
  })

  it('starts QEMU, waits for the agent and records what it runs with', async () => {
    const started = VmCliStartResult.parse(
      await ok(VmCliStartOutput, 'start', ws, '--wait', '--timeout-sec', '20'),
    )
    expect(started).toMatchObject({ accel: 'tcg', slow: true, agentReady: true, fallback: null })
    expect(pidAlive(started.pid)).toBe(true)
    expect(qemuIdentity(started.pid)).toBe('yes')
    expect(config().running).toMatchObject({ pid: started.pid, cpus: 2, memGb: 4, accel: 'tcg' })

    const args = JSON.parse(fs.readFileSync(path.join(ws, 'vm', 'fake-qemu-args.json'), 'utf8')) as string[]
    expect(args.slice(0, 2)).toEqual(['-L', path.join(root, 'qemu', 'share', 'qemu')])
    expect(args[args.indexOf('-smp') + 1]).toBe('2')
    expect(args[args.indexOf('-qmp') + 1]).toBe('unix:qmp.sock,server=on,wait=off')
    expect(gvproxyIdentity(gvproxyPid())).toBe('yes')
    const net = JSON.parse(fs.readFileSync(path.join(ws, 'vm', 'gvproxy.json'), 'utf8')) as {
      interfaces: { qemu: string }
    }
    expect(net.interfaces.qemu).toBe(`tcp://127.0.0.1:${portBase + 52}`)

    const status = await ok(VmCliStatus, 'status', ws)
    expect(status).toMatchObject({
      state: 'running',
      pid: started.pid,
      qmpStatus: 'running',
      agentReachable: true,
    })
    expect(status.running?.pid).toBe(started.pid)

    const again = await ok(VmCliStartOutput, 'start', ws)
    expect(again).toMatchObject({ alreadyRunning: true, state: 'running' })
  })

  it('refuses disk and port changes while running; CPU and memory apply on the next boot', async () => {
    await fails('VM_RUNNING', 1, 'snapshot', 'create', ws, 'live')
    await fails('VM_RUNNING', 1, 'grow-disk', ws, 'data', '80')
    await fails('VM_RUNNING', 1, 'resize', ws, '--port-base', String(portBase + 100))
    const resized = await ok(VmCliResizeResult, 'resize', ws, '--cpus', '3')
    expect(resized).toMatchObject({ cpus: 3, running: true, appliesOnNextBoot: true })
    expect(config().running?.cpus).toBe(2)
  })

  it('stops through ACPI, takes gvproxy down with QEMU and forgets the running record', async () => {
    const pid = config().running?.pid as number
    const netPid = gvproxyPid()
    const stopped = await ok(VmCliStopResult, 'stop', ws, '--timeout-sec', '10')
    expect(stopped).toMatchObject({ state: 'stopped', method: 'acpi' })
    expect(pidAlive(pid)).toBe(false)
    expect(pidAlive(netPid)).toBe(false)
    expect(fs.existsSync(path.join(ws, 'vm', 'gvproxy.pid'))).toBe(false)
    expect(config().running).toBeUndefined()
    expect(fs.existsSync(path.join(ws, 'vm', 'qemu.pid'))).toBe(false)
    expect(await ok(VmCliStopResult, 'stop', ws)).toMatchObject({ alreadyStopped: true })
  })

  it('grows disks but never shrinks them', async () => {
    const grown = await ok(VmCliGrowDiskResult, 'grow-disk', ws, 'data', '80')
    expect(grown).toMatchObject({ disk: 'data', changed: true, virtualBytes: 80 * 1024 ** 3 })
    expect(config().dataGb).toBe(80)
    await fails('CANNOT_SHRINK', 1, 'grow-disk', ws, 'data', '10')
    await fails('USAGE', 2, 'grow-disk', ws, 'swap', '10')
  })

  it('bounds the port base by the ports the host binds', async () => {
    await fails('USAGE', 2, 'resize', ws, '--port-base', '65484')
    const moved = await ok(VmCliResizeResult, 'resize', ws, '--port-base', '65483')
    expect(moved.ports).toMatchObject({ agent: 65483, vncLast: 65533 })
    await ok(VmCliResizeResult, 'resize', ws, '--port-base', String(portBase))
  })

  it('recreates the system overlay on reset, keeping the data disk', async () => {
    await ok(VmCliSnapshotResult, 'snapshot', 'create', ws, 'gone-after-reset')
    const reset = await ok(VmCliResetResult, 'reset-system', ws, '--golden', fake.golden)
    expect(reset).toMatchObject({ reset: true, stoppedFirst: false })
    expect((await ok(VmCliSnapshotResult, 'snapshot', 'list', ws)).snapshots).toEqual([])
    expect(config().systemResetAt).toBeTruthy()
    const status = await ok(VmCliStatus, 'status', ws)
    expect(status.disks.data).toMatchObject({ exists: true, virtualBytes: 80 * 1024 ** 3 })
    expect(status.disks.system).toMatchObject({ backingFile: fs.realpathSync(fake.golden) })
  })

  it('reports usage errors with exit code 2', async () => {
    await fails('USAGE', 2, 'nope', ws)
    await fails('USAGE', 2, 'stop')
    await fails('NOT_FOUND', 1, 'status', path.join(root, 'missing'))
  })
})
