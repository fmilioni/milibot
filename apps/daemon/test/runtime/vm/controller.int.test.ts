import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { VmCliStartResult, VmInfo } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveGoldenImage } from '../../../src/golden/resolve'
import { isVmRunning, onVmTransition, QemuVmController } from '../../../src/runtime/vm/controller'
import type { GuestAgentBundle } from '../../../src/vm-cli'
import { fakeGuest } from '../../support/fake-guest'
import { FakeVmCli } from '../../support/fake-vm-cli'
import { removeDir, tempDir } from '../../support/temp'

let dir: string
const bots = [
  { slug: 'lead', linuxUid: 2001, displayNum: 1 },
  { slug: 'ana', linuxUid: 2002, displayNum: 2 },
]

function controller(
  options: {
    golden?: string | null
    cli?: FakeVmCli
    limits?: () => { cpuPercent: number; memoryMb: number } | null
    bundle?: GuestAgentBundle | null
    whpxProbeTimeoutMs?: number
  } = {},
) {
  const cli = options.cli ?? new FakeVmCli()
  const guest = fakeGuest()
  const events: VmInfo[] = []
  const vm = new QemuVmController({
    workspaceDir: dir,
    workspaceName: 'test',
    portBase: 47300,
    cli,
    golden: () => (options.golden === undefined ? '/images/debian13-golden.qcow2' : options.golden),
    settings: () => ({ cpus: 2, memGb: 4, dataGb: 20, systemGb: 30 }),
    bots: () => bots,
    emit: (info) => events.push(info),
    guestFactory: guest.client,
    pollIntervalMs: 5,
    watchIntervalMs: 20,
    ...(options.limits ? { botLimits: options.limits } : {}),
    ...(options.bundle !== undefined ? { agentBundle: () => options.bundle ?? null } : {}),
    ...(options.whpxProbeTimeoutMs !== undefined ? { whpxProbeTimeoutMs: options.whpxProbeTimeoutMs } : {}),
  })
  return { vm, cli, guest, events }
}

beforeEach(() => {
  dir = realpathSync(tempDir('vm'))
})

afterEach(() => removeDir(dir))

describe('QemuVmController', () => {
  describe('WHPX irqchip probe (Windows)', () => {
    const whpxDefault: Partial<VmCliStartResult> = {
      accel: 'whpx',
      whpxKernelIrqchip: 'default',
      whpxKernelIrqchipForced: false,
    }

    it('restarts once with kernel-irqchip=off when the guest hangs on the default', async () => {
      const cli = new FakeVmCli()
      cli.startResults = [whpxDefault, { accel: 'whpx', whpxKernelIrqchip: 'off' }]
      const { vm, guest } = controller({ cli, whpxProbeTimeoutMs: 60 })
      guest.state.healthy = false
      cli.onStart = (_vmDir, args) => {
        if (args.includes('off')) guest.state.healthy = true
      }
      await vm.start()
      expect(cli.calls.map((c) => c.join(' ').replace(dir, '<ws>'))).toEqual([
        expect.stringMatching(/^create <ws>/),
        'start <ws>',
        'stop <ws> --force',
        'start <ws> --whpx-kernel-irqchip off',
      ])
      expect(vm.info().state).toBe('running')
      await vm.close()
    })

    it('restarts right away when QEMU logs failed interrupt injections', async () => {
      const cli = new FakeVmCli()
      cli.startResults = [whpxDefault, { accel: 'whpx', whpxKernelIrqchip: 'off' }]
      const { vm, guest } = controller({ cli, whpxProbeTimeoutMs: 60_000 })
      guest.state.healthy = false
      cli.onStart = (vmDir, args) => {
        if (args.includes('off')) {
          writeFileSync(join(vmDir, 'qemu.log'), '')
          guest.state.healthy = true
        } else {
          writeFileSync(
            join(vmDir, 'qemu.log'),
            'whpx: injection failed, MSI (0, 0) delivery: 0, lost (c0350005)\n',
          )
        }
      }
      const started = Date.now()
      await vm.start()
      expect(Date.now() - started).toBeLessThan(5000)
      expect(cli.calls.map((c) => c[0])).toEqual(['create', 'start', 'stop', 'start'])
      await vm.close()
    })

    it('does not probe a forced, saved or non-WHPX irqchip', async () => {
      const results: Partial<VmCliStartResult>[] = [
        { accel: 'whpx', whpxKernelIrqchip: 'on', whpxKernelIrqchipForced: true },
        { accel: 'whpx', whpxKernelIrqchip: 'off' },
        { accel: 'kvm', whpxKernelIrqchip: null },
      ]
      for (const result of results) {
        rmSync(join(dir, 'vm'), { recursive: true, force: true })
        const cli = new FakeVmCli()
        cli.startResults = [result]
        const { vm, guest } = controller({ cli, whpxProbeTimeoutMs: 30 })
        guest.state.healthy = false
        setTimeout(() => (guest.state.healthy = true), 150)
        await vm.start()
        expect(cli.calls.map((c) => c[0])).toEqual(['create', 'start'])
        await vm.close()
      }
    })
  })

  it('creates the VM with workspace settings, boots, waits for the guest and provisions bots', async () => {
    const { vm, cli, guest, events } = controller()
    expect(vm.info()).toMatchObject({ state: 'not_created', portBase: 47300, config: { cpus: 2, memGb: 4 } })
    await vm.start()
    expect(cli.calls.map((c) => c[0])).toEqual(['create', 'start'])
    expect(cli.calls[0]).toEqual(
      expect.arrayContaining([
        '--port-base',
        '47300',
        '--cpus',
        '2',
        '--mem-gb',
        '4',
        '--golden',
        '/images/debian13-golden.qcow2',
      ]),
    )
    expect(guest.state.provisioned).toEqual([
      { slug: 'lead', uid: 2001, display: 1 },
      { slug: 'ana', uid: 2002, display: 2 },
    ])
    expect(events.map((e) => e.phase ?? e.state)).toEqual([
      'starting',
      'creating',
      'booting',
      'provisioning',
      'running',
    ])
    expect(vm.info()).toMatchObject({ state: 'running', desktops: 2, config: { dataGb: 20, systemGb: 30 } })
    expect(vm.vncPort(2)).toBe(47302)

    await vm.provisionBot({ slug: 'new', linuxUid: 2003, displayNum: 3 })
    expect(vm.info().desktops).toBe(3)

    await vm.stop()
    expect(vm.info().state).toBe('stopped')
    expect(cli.calls.at(-1)?.[0]).toBe('stop')
    await vm.close()
  })

  it('reports each time the VM comes up or goes down, once per edge', async () => {
    const { vm } = controller()
    const edges: string[] = []
    const unsubscribe = onVmTransition(vm, { up: () => edges.push('up'), down: () => edges.push('down') })
    expect(edges).toEqual([])
    await vm.start()
    expect(isVmRunning(vm)).toBe(true)
    expect(edges).toEqual(['up'])
    const late: string[] = []
    const stopLate = onVmTransition(vm, { up: () => late.push('up') })
    expect(late).toEqual(['up'])
    await vm.stop()
    expect(isVmRunning(vm)).toBe(false)
    expect(edges).toEqual(['up', 'down'])
    unsubscribe()
    stopLate()
    await vm.start()
    expect(edges).toEqual(['up', 'down'])
    expect(late).toEqual(['up'])
    await vm.close()
  })

  it('applies the per-bot limits at boot, to a new bot and live, and clears them', async () => {
    let limits: { cpuPercent: number; memoryMb: number } | null = { cpuPercent: 150, memoryMb: 3072 }
    const { vm, guest } = controller({ limits: () => limits })
    await vm.start()
    expect(guest.state.limits).toEqual([
      {
        bots: [
          { slug: 'lead', uid: 2001 },
          { slug: 'ana', uid: 2002 },
        ],
        limits: { cpuPercent: 150, memoryMb: 3072 },
      },
    ])
    await vm.provisionBot({ slug: 'new', linuxUid: 2003, displayNum: 3 })
    expect(guest.state.limits.at(-1)).toEqual({
      bots: [{ slug: 'new', uid: 2003 }],
      limits: { cpuPercent: 150, memoryMb: 3072 },
    })
    limits = null
    await vm.applyBotLimits()
    expect(guest.state.limits.at(-1)).toMatchObject({ limits: null })
    await vm.stop()
    await vm.close()
  })

  it('boots without limits when they are off', async () => {
    const off = controller({ limits: () => null })
    await off.vm.start()
    expect(off.guest.state.limits).toEqual([])
    await off.vm.close()
  })

  it('replaces an outdated guest agent at boot with the bundled one', async () => {
    const content = 'console.log("new agent")\n'
    const sha = createHash('sha256').update(content).digest('hex').slice(0, 16)
    const { vm, guest } = controller({ bundle: { sha, content } })
    guest.state.agentSha = 'old0000000000000'
    await vm.start()
    const update = guest.state.execs.find((e) => e.user === 'root')
    expect(update).toMatchObject({ user: 'root', cwd: '/', stdin: content })
    expect(String(update?.cmd)).toContain('systemctl restart milibot-guest-agent.service')
    expect(guest.state.agentSha).toBe(sha)
    expect(vm.info().state).toBe('running')
    await vm.close()

    const current = controller({ bundle: { sha, content } })
    current.guest.state.agentSha = sha
    await current.vm.start()
    expect(current.guest.state.execs).toEqual([])
    await current.vm.close()
  })

  it('reports a clear error when the golden image is missing', async () => {
    const { vm, events } = controller({ golden: null })
    await expect(vm.start()).rejects.toThrow(/golden image/)
    expect(events.at(-1)).toMatchObject({ state: 'error', errorCode: 'GOLDEN_NOT_FOUND' })
  })

  it('surfaces CLI failures (e.g. ports in use) as vm.status errors', async () => {
    const cli = new FakeVmCli()
    cli.failWith = { command: 'start', code: 'PORT_IN_USE' }
    const { vm } = controller({ cli })
    await expect(vm.start()).rejects.toThrow()
    expect(vm.info()).toMatchObject({ state: 'error', errorCode: 'PORT_IN_USE' })
  })

  it('adopts a VM left running and notices when QEMU exits', async () => {
    const first = controller()
    await first.vm.start()
    await first.vm.close()

    const second = controller()
    expect(second.vm.processRunning()).toBe(true)
    await second.vm.start()
    expect(second.cli.calls.map((c) => c[0])).toEqual([])
    expect(second.vm.info().state).toBe('running')
    rmSync(join(dir, 'vm', 'qemu.pid'))
    await new Promise((r) => setTimeout(r, 60))
    expect(second.vm.info().state).toBe('stopped')
    await second.vm.close()
  })

  it('ignores a stale qemu.pid whose pid now belongs to another program and boots the VM', async () => {
    const first = controller()
    await first.vm.start()
    await first.vm.close()

    // The fake writes this process's pid: an unrelated program until `start` runs QEMU again.
    let qemuRunning = false
    const cli = Object.assign(new FakeVmCli(), { isVmProcess: () => qemuRunning })
    cli.onStart = () => {
      qemuRunning = true
    }
    const second = controller({ cli })
    expect(second.vm.processRunning()).toBe(false)
    await second.vm.start()
    expect(cli.calls.map((c) => c[0])).toEqual(['start'])
    expect(second.vm.info().state).toBe('running')
    await second.vm.close()
  })

  it('does not re-provision desktops that are already running with the same uid and display', async () => {
    const { vm, guest } = controller()
    guest.state.runningDesktops = [
      { slug: 'lead', uid: 2001, display: 1 },
      { slug: 'ana', uid: 2002, display: 7 },
    ]
    await vm.start()
    expect(guest.state.provisioned).toEqual([{ slug: 'ana', uid: 2002, display: 2 }])
    expect(vm.info().desktops).toBe(2)
    await vm.provisionBot({ slug: 'lead', linuxUid: 2001, displayNum: 1 })
    guest.state.runningDesktops.push({ slug: 'new', uid: 2003, display: 3 })
    await vm.provisionBot({ slug: 'new', linuxUid: 2003, displayNum: 3 })
    expect(guest.state.provisioned).toHaveLength(1)
    expect(vm.info().desktops).toBe(3)
    await vm.close()
  })

  it('reset recreates the system disk and re-provisions', async () => {
    const { vm, cli, guest } = controller()
    await vm.start()
    await vm.reset()
    expect(cli.calls.map((c) => c[0])).toEqual(['create', 'start', 'stop', 'reset-system', 'start'])
    expect(guest.state.provisioned).toHaveLength(4)
    await vm.close()
  })

  it('finds the golden image under the data root or the default root', () => {
    const root = join(dir, 'root')
    const fallback = join(dir, 'default')
    const pointTo = (imagesRoot: string, arch: 'arm64' | 'amd64', file: string) => {
      mkdirSync(join(imagesRoot, 'images'), { recursive: true })
      writeFileSync(join(imagesRoot, 'images', file), '')
      writeFileSync(
        join(imagesRoot, 'images', 'current.json'),
        JSON.stringify({ version: 1, images: { [arch]: file } }),
      )
    }
    pointTo(fallback, 'arm64', 'debian13-golden-1-arm64.qcow2')
    const arm = { platform: 'darwin', arch: 'arm64', env: {}, homedir: dir }
    const x64 = { platform: 'linux', arch: 'x64', env: {}, homedir: dir }
    expect(resolveGoldenImage(root, fallback, null, arm)).toBe(
      join(fallback, 'images', 'debian13-golden-1-arm64.qcow2'),
    )
    expect(resolveGoldenImage(root, fallback, null, x64)).toBeNull()
    expect(resolveGoldenImage(root, join(dir, 'nothing'), null, arm)).toBeNull()
    // Per architecture; the data root wins over the default root.
    pointTo(root, 'amd64', 'debian13-golden-2-amd64.qcow2')
    expect(resolveGoldenImage(root, fallback, null, x64)).toBe(
      join(root, 'images', 'debian13-golden-2-amd64.qcow2'),
    )
    expect(resolveGoldenImage(root, fallback, null, arm)).toBe(
      join(fallback, 'images', 'debian13-golden-1-arm64.qcow2'),
    )
    const forced = join(fallback, 'images', 'debian13-golden-1-arm64.qcow2')
    expect(resolveGoldenImage(root, fallback, forced)).toBe(forced)
    expect(resolveGoldenImage(root, fallback, join(dir, 'missing.qcow2'))).toBeNull()
  })
})
