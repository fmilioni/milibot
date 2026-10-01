import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FakeProvider } from '@milibot/agent/testing'
import type { VmDetails, VmStatsResponse, WorkspaceEvent } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { FakeGuest } from '../../support/fake-guest'
import { FakeVmCli } from '../../support/fake-vm-cli'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let events: WorkspaceEvent[]
let guest: FakeGuest
let cli: FakeVmCli
let goldenFile: string
let latestRevision: number

const GiB = 1024 ** 3

const dir = useTempDir('vm-routes')
afterEach(stopRuntimes)

beforeEach(() => {
  goldenFile = '/images/debian13-golden.qcow2'
  latestRevision = 1
})

async function boot() {
  cli = new FakeVmCli()
  h = await bootRuntime({
    dir: dir(),
    provider: new FakeProvider({ script: [], fallback: { text: 'ok' } }),
    host: { compaction: false },
    vm: { cli, options: { golden: () => goldenFile, latestGoldenRevision: () => latestRevision } },
  })
  ;({ runtime, events, guest } = h)
  return { vm: h.vm! }
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function taskDone(): Promise<VmDetails> {
  await runtime.services.vmAdmin.settled()
  return call<VmDetails>('getVmDetails')
}

describe('VM routes (fake VM)', () => {
  it('reports disks and restore points and stores CPU/memory for the next boot', async () => {
    await boot()
    const details = await call<VmDetails>('getVmDetails')
    expect(details.vm.state).toBe('running')
    expect(details.disks.data).toEqual({ virtualBytes: 20 * GiB, actualBytes: 5 * GiB })
    expect(details.snapshots).toEqual([])

    const updated = await call<VmDetails>('updateVmResources', {}, { cpus: 6, memGb: 12 })
    expect(updated.vm.config).toMatchObject({ cpus: 6, memGb: 12 })
    expect(runtime.store.settings.get('vm.memory_gb', null)).toBe(12)
    expect(cli.calls.find((c) => c[0] === 'resize')).toEqual(
      expect.arrayContaining(['--cpus', '6', '--mem-gb', '12']),
    )
  })

  it('reports live usage while the VM runs', async () => {
    const { vm } = await boot()
    const bot = runtime.store.bots.list()[0]!
    guest.state.stats = {
      ...guest.state.stats,
      at: 1000,
      cpu: { totalTicks: 1000, idleTicks: 750 },
      bots: [{ slug: bot.slug, memoryBytes: GiB, cpuUsageUsec: 0 }],
    }
    let stats: VmStatsResponse['stats'] = null
    for (let i = 0; i < 100 && !stats; i++) {
      stats = (await call<VmStatsResponse>('getVmStats')).stats
      if (!stats) await new Promise((r) => setTimeout(r, 50))
    }
    expect(stats).toMatchObject({
      cpus: 4,
      memory: { totalBytes: 8 * GiB, usedBytes: 2 * GiB, cacheBytes: GiB },
      disks: {
        system: { usedBytes: 10 * GiB, totalBytes: 40 * GiB },
        data: { usedBytes: 20 * GiB, totalBytes: 60 * GiB },
      },
      bots: [{ botId: bot.id, memoryBytes: GiB }],
      other: { memoryBytes: GiB },
    })

    await vm.stop()
    expect((await call<VmStatsResponse>('getVmStats')).stats).toBeNull()
  })

  it('grows a disk by stopping the VM, resizing and booting it again', async () => {
    const { vm } = await boot()
    await expect(call('growVmDisk', {}, { disk: 'data', sizeGb: 10 })).rejects.toThrow(/only grow/)
    const started = cli.calls.length
    const pending = await call<VmDetails>('growVmDisk', {}, { disk: 'data', sizeGb: 80 })
    expect(pending.task).toMatchObject({ kind: 'grow_disk', status: 'running' })
    const done = await taskDone()
    expect(done.task).toMatchObject({ kind: 'grow_disk', status: 'done' })
    expect(
      cli.calls
        .slice(started)
        .map((c) => c[0])
        .filter((c) => c !== 'status'),
    ).toEqual(['stop', 'grow-disk', 'start'])
    expect(done.disks.data?.virtualBytes).toBe(80 * GiB)
    expect(vm.info().state).toBe('running')
    expect(events.some((e) => e.type === 'vm.status' && e.payload.vm.state === 'stopping')).toBe(true)
  })

  it('creates, restores and deletes restore points with the VM stopped', async () => {
    await boot()
    await call('createVmSnapshot', {}, { name: 'before-upgrade' })
    let details = await taskDone()
    expect(details.snapshots.map((s) => s.name)).toEqual(['before-upgrade'])
    expect(details.vm.state).toBe('running')
    await expect(call('createVmSnapshot', {}, { name: 'before-upgrade' })).rejects.toThrow(/already exists/)

    await call('restoreVmSnapshot', { name: 'before-upgrade' })
    await taskDone()
    expect(cli.restored).toEqual(['before-upgrade'])

    await call('deleteVmSnapshot', { name: 'before-upgrade' })
    details = await taskDone()
    expect(details.snapshots).toEqual([])
    await expect(call('restoreVmSnapshot', { name: 'nope' })).rejects.toThrow(/not found/)
  })

  it('updates the VM system once the new golden image exists, keeping the data disk', async () => {
    const images = join(dir(), 'images')
    mkdirSync(images)
    const golden = (revision: number) => {
      const file = join(images, `debian13-golden-${revision}-arm64.qcow2`)
      writeFileSync(file, '')
      writeFileSync(file.replace(/\.qcow2$/, '.json'), JSON.stringify({ revision }))
      return file
    }
    goldenFile = golden(1)
    const { vm } = await boot()
    expect(vm.info().system).toEqual({ goldenVersion: '1', revision: 1, latestRevision: 1 })
    await expect(call('updateVmSystem', {}, { whenIdle: false })).rejects.toThrow(/already up to date/)

    latestRevision = 2
    const waiting = await call<VmDetails>('updateVmSystem', {}, { whenIdle: false })
    expect(waiting.task).toBeNull()
    expect(waiting.systemUpdate).toMatchObject({ status: 'waiting_golden', whenIdle: false })
    expect(waiting.vm.system).toMatchObject({ revision: 1, latestRevision: 2 })
    expect(runtime.store.settings.get('vm.system_update', null)).toMatchObject({ whenIdle: false })
    // Waiting for the image does not hold the VM: other operations run meanwhile.
    await call('createVmSnapshot', {}, { name: 'before' })
    await until(() => cli.calls.some((c) => c[0] === 'snapshot' && c[1] === 'create'))
    const meanwhile = await call<VmDetails>('getVmDetails')
    expect(meanwhile.systemUpdate?.status).toBe('waiting_golden')
    await call('cancelVmSystemUpdate')
    const cancelled = await taskDone()
    expect(cancelled.task).toMatchObject({ kind: 'snapshot_create', status: 'done' })
    expect(cancelled.systemUpdate).toBeNull()
    expect(runtime.store.settings.get('vm.system_update', null)).toBeNull()

    goldenFile = golden(2)
    await call('updateVmSystem', {}, { whenIdle: true })
    const done = await taskDone()
    expect(done.vm.system).toEqual({ goldenVersion: '2', revision: 2, latestRevision: 2 })
    expect(done.task).toMatchObject({ kind: 'update_system', status: 'done' })
    expect(cli.calls.find((c) => c[0] === 'reset-system')).toEqual([
      'reset-system',
      dir(),
      '--golden',
      goldenFile,
    ])
    expect(vm.info().state).toBe('running')
    expect(runtime.store.settings.get('vm.system_update', null)).toBeNull()

    await call('resetVm')
    expect((await taskDone()).task).toMatchObject({ kind: 'reset', status: 'done' })
  })
})
