import type { VmInfo } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { DaemonError } from '../../../src/errors'
import { readVmConfig, type SystemUpdateRequest, VmAdmin } from '../../../src/runtime/vm/admin'
import { createPlaceholderVm, type VmController } from '../../../src/runtime/vm/controller'

function fakeVm(options: { state?: VmInfo['state']; revision?: number | null; latest?: number } = {}) {
  const latest = options.latest ?? 2
  const state = {
    info: {
      state: options.state ?? 'running',
      config: { cpus: 2, memGb: 4, dataGb: 20, systemGb: 30 },
      portBase: 47000,
      desktops: 1,
      ...(options.revision === null
        ? {}
        : { system: { goldenVersion: '1', revision: options.revision ?? 1, latestRevision: latest } }),
    } as VmInfo,
    available: 1 as number | null,
    resets: [] as Array<{ boot?: boolean }>,
  }
  const vm: VmController = {
    ...createPlaceholderVm(),
    info: () => state.info,
    processRunning: () => state.info.state === 'running',
    start: async () => {
      state.info = { ...state.info, state: 'running' }
    },
    reset: async (opts = {}) => {
      state.resets.push(opts)
      const system = state.info.system
      state.info = {
        ...state.info,
        state: opts.boot === false ? 'stopped' : 'running',
        ...(system ? { system: { ...system, revision: state.available ?? system.revision } } : {}),
      }
    },
    goldenRevisions: () => ({ available: state.available, latest }),
  }
  return { vm, state }
}

function admin(vm: VmController, extra: { working?: () => number; idle?: () => Promise<void> } = {}) {
  let stored: SystemUpdateRequest | null = null
  let changes = 0
  const vmAdmin = new VmAdmin({
    vm,
    desired: () => ({ cpus: 2, memGb: 4 }),
    saveDesired: () => undefined,
    workingBots: extra.working ?? (() => 0),
    idle: extra.idle ?? (() => Promise.resolve()),
    now: () => 1000,
    changed: () => {
      changes++
    },
    goldenRevisions: () => vm.goldenRevisions(),
    systemUpdate: {
      load: () => stored,
      save: (request) => {
        stored = request
      },
    },
    goldenPollMs: 2,
  })
  return {
    vmAdmin,
    stored: () => stored,
    setStored: (request: SystemUpdateRequest | null) => {
      stored = request
    },
    changes: () => changes,
  }
}

async function until(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 2))
  }
}

describe('VmAdmin.updateSystem', () => {
  it('refuses a VM not created yet or already up to date', async () => {
    const missing = admin(fakeVm({ revision: null }).vm)
    expect(() => missing.vmAdmin.updateSystem(true)).toThrow(DaemonError)
    const current = admin(fakeVm({ revision: 2 }).vm)
    expect(() => current.vmAdmin.updateSystem(true)).toThrow(/already up to date/)
    expect(current.stored()).toBeNull()
  })

  it('waits for the new golden image, then replaces the system and boots a running VM again', async () => {
    const { vm, state } = fakeVm()
    const { vmAdmin, stored } = admin(vm)
    const details = await vmAdmin.updateSystem(false)
    expect(details.task).toBeNull()
    expect(details.systemUpdate).toEqual({ status: 'waiting_golden', whenIdle: false, requestedAt: 1000 })
    expect(stored()).toEqual({ whenIdle: false, requestedAt: 1000 })
    await new Promise((r) => setTimeout(r, 10))
    expect(state.resets).toHaveLength(0)
    state.available = 2
    await until(() => state.resets.length === 1)
    await vmAdmin.settled()
    expect(state.resets).toEqual([{ boot: true }])
    const after = await vmAdmin.details()
    expect(after.task).toMatchObject({ kind: 'update_system', status: 'done' })
    expect(after.systemUpdate).toBeNull()
    expect(vm.info().system?.revision).toBe(2)
    expect(stored()).toBeNull()
  })

  it('keeps a stopped VM stopped', async () => {
    const { vm, state } = fakeVm({ state: 'stopped' })
    state.available = 2
    const { vmAdmin } = admin(vm)
    await vmAdmin.updateSystem(true)
    await vmAdmin.settled()
    expect(state.resets).toEqual([{ boot: false }])
    expect(vm.info().state).toBe('stopped')
  })

  it('waits for the bots to be idle when asked to', async () => {
    const { vm, state } = fakeVm()
    state.available = 2
    let release: () => void = () => undefined
    const idle = new Promise<void>((resolve) => {
      release = resolve
    })
    const { vmAdmin } = admin(vm, { working: () => 2, idle: () => idle })
    expect((await vmAdmin.updateSystem(true)).systemUpdate?.status).toBe('waiting_idle')
    await new Promise((r) => setTimeout(r, 5))
    expect(state.resets).toHaveLength(0)
    release()
    await vmAdmin.settled()
    expect(state.resets).toEqual([{ boot: true }])
  })

  it('cancels while waiting, forgetting the request', async () => {
    const { vm, state } = fakeVm()
    const { vmAdmin, stored } = admin(vm)
    await vmAdmin.updateSystem(true)
    expect(() => vmAdmin.updateSystem(true)).toThrow(/in progress/)
    const details = await vmAdmin.cancelSystemUpdate()
    expect(details.task).toBeNull()
    expect(details.systemUpdate).toBeNull()
    expect(stored()).toBeNull()
    state.available = 2
    await new Promise((r) => setTimeout(r, 10))
    expect(state.resets).toHaveLength(0)
    await expect(vmAdmin.cancelSystemUpdate()).rejects.toThrow(/No system update/)
  })

  it('resumes a request saved by a previous runtime and keeps it when the runtime stops', async () => {
    const { vm, state } = fakeVm()
    const first = admin(vm)
    first.setStored({ whenIdle: true, requestedAt: 5 })
    first.vmAdmin.resumeSystemUpdate()
    expect((await first.vmAdmin.details()).systemUpdate?.status).toBe('waiting_golden')
    first.vmAdmin.close()
    await first.vmAdmin.settled()
    expect(first.stored()).toEqual({ whenIdle: true, requestedAt: 5 })

    const second = admin(vm)
    second.setStored(first.stored())
    state.available = 2
    second.vmAdmin.resumeSystemUpdate()
    await second.vmAdmin.settled()
    expect(state.resets).toEqual([{ boot: true }])
    expect(second.stored()).toBeNull()

    const third = admin(vm)
    third.setStored({ whenIdle: true, requestedAt: 6 })
    third.vmAdmin.resumeSystemUpdate()
    expect((await third.vmAdmin.details()).systemUpdate).toBeNull()
    expect(third.stored()).toBeNull()
  })

  it('reports a failed replacement and forgets the request', async () => {
    const { vm, state } = fakeVm()
    state.available = 2
    vm.reset = () => Promise.reject(new Error('disk busy'))
    const { vmAdmin, stored } = admin(vm)
    await vmAdmin.updateSystem(false)
    await vmAdmin.settled()
    expect((await vmAdmin.details()).task).toMatchObject({ status: 'error', error: 'disk busy' })
    expect(stored()).toBeNull()
  })

  it('lets other operations run while it waits, then starts once they end', async () => {
    const { vm, state } = fakeVm()
    let releaseStop: () => void = () => undefined
    vm.stop = () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve
      })
    const { vmAdmin } = admin(vm)
    await vmAdmin.updateSystem(false)
    const restarting = await vmAdmin.restart(false)
    expect(restarting.task).toMatchObject({ kind: 'restart', status: 'running' })
    expect(restarting.systemUpdate?.status).toBe('waiting_golden')
    expect(() => vmAdmin.updateSystem(false)).toThrow(/already in progress/)

    state.available = 2
    await new Promise((r) => setTimeout(r, 10))
    expect(state.resets).toHaveLength(0)
    expect((await vmAdmin.details()).systemUpdate?.status).toBe('waiting_task')
    releaseStop()
    await vmAdmin.settled()
    expect(state.resets).toEqual([{ boot: true }])
    const details = await vmAdmin.details()
    expect(details.task).toMatchObject({ kind: 'update_system', status: 'done' })
    expect(details.systemUpdate).toBeNull()
  })

  it('queues behind an operation already running when requested', async () => {
    const { vm, state } = fakeVm()
    state.available = 2
    let releaseStop: () => void = () => undefined
    vm.stop = () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve
      })
    const { vmAdmin } = admin(vm)
    await vmAdmin.restart(false)
    expect((await vmAdmin.updateSystem(false)).systemUpdate?.status).toBe('waiting_task')
    releaseStop()
    await vmAdmin.settled()
    expect(state.resets).toEqual([{ boot: true }])
  })

  it('is dropped when "Resetar sistema" lands on the newest system', async () => {
    const { vm, state } = fakeVm()
    state.available = 2
    const { vmAdmin, stored } = admin(vm, { working: () => 1, idle: () => new Promise(() => undefined) })
    expect((await vmAdmin.updateSystem(true)).systemUpdate?.status).toBe('waiting_idle')
    await vmAdmin.reset()
    await vmAdmin.settled()
    const details = await vmAdmin.details()
    expect(details.task).toMatchObject({ kind: 'reset', status: 'done' })
    expect(details.systemUpdate).toBeNull()
    expect(stored()).toBeNull()
    expect(state.resets).toEqual([{}])
    expect(vm.info().system?.revision).toBe(2)
  })

  it('keeps waiting when the reset happens before the new golden image exists', async () => {
    const { vm, state } = fakeVm()
    const { vmAdmin, stored } = admin(vm)
    await vmAdmin.updateSystem(false)
    await vmAdmin.reset()
    await until(() => state.resets.length === 1)
    await new Promise((r) => setTimeout(r, 10))
    expect((await vmAdmin.details()).systemUpdate?.status).toBe('waiting_golden')
    expect(stored()).not.toBeNull()
    state.available = 2
    await vmAdmin.settled()
    expect(state.resets).toEqual([{}, { boot: true }])
    expect(vm.info().system?.revision).toBe(2)
  })
})

describe('VM size settings', () => {
  it('reads the VM size, falling back per field', () => {
    const values: Record<string, unknown> = { 'vm.vcpus': 2, 'vm.memory_gb': 0, 'vm.data_disk_gb': 'big' }
    const get = <T>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback)
    expect(readVmConfig(get, { cpus: 4, memGb: 8, dataGb: 60, systemGb: 40 })).toEqual({
      cpus: 2,
      memGb: 8,
      dataGb: 60,
      systemGb: 40,
    })
  })
})
