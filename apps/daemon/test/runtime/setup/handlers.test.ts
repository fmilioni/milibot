import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SetupRoutes } from '../../../src/runtime/setup/handlers'
import { createPlaceholderVm, type VmController } from '../../../src/runtime/vm/controller'
import type { GuestClient } from '../../../src/runtime/vm/guest-client'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { seedWorkspace } from '../../../src/workspace-db/seed'
import { SETUP_PENDING_KEY, SETUP_VM_PENDING_KEY } from '../../../src/workspace-db/setup-keys'

let store: WorkspaceStore

beforeEach(() => {
  const db = openWorkspaceDb(':memory:')
  store = new WorkspaceStore(db, () => 1_000)
  seedWorkspace(store, 'pt-BR')
  store.settings.set(SETUP_PENDING_KEY, true)
  store.settings.set(SETUP_VM_PENDING_KEY, true)
})

function vmWith(overrides: Partial<VmController>): VmController {
  return { ...createPlaceholderVm(), ...overrides }
}

const noArgs = { params: { workspaceId: 'ws' }, query: undefined, body: undefined }

describe('setup runtime', () => {
  it('stores the chosen VM size, clears the VM hold and boots only when asked', async () => {
    const start = vi.fn(() => Promise.resolve())
    const handlers = new SetupRoutes({
      store,
      vm: vmWith({ start }),
      introduceFirstBot: () => {},
      log: () => {},
    }).handlers()
    await handlers.configureSetupVm({ ...noArgs, body: { cpus: 2, memGb: 4, dataGb: 40, start: false } })
    expect(start).not.toHaveBeenCalled()
    expect(store.settings.get(SETUP_VM_PENDING_KEY, true)).toBe(false)
    expect([
      store.settings.get('vm.vcpus', 0),
      store.settings.get('vm.memory_gb', 0),
      store.settings.get('vm.data_disk_gb', 0),
    ]).toEqual([2, 4, 40])
    await handlers.configureSetupVm({ ...noArgs, body: { cpus: 4, memGb: 8, dataGb: 60, start: true } })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('lets the first bot introduce itself when the setup finishes, closing the login terminal', async () => {
    const introduceFirstBot = vi.fn()
    const killProcs = vi.fn(async () => 1)
    const vm = vmWith({
      status: () => ({ state: 'running', desktops: 1 }),
      runningGuest: () => ({ killProcs }) as unknown as GuestClient,
    })
    const handlers = new SetupRoutes({ store, vm, introduceFirstBot, log: () => {} }).handlers()
    await handlers.finishSetup(noArgs)
    expect(store.settings.get(SETUP_PENDING_KEY, true)).toBe(false)
    expect(introduceFirstBot).toHaveBeenCalledTimes(1)
    expect(killProcs.mock.calls).toEqual([['login:claude'], ['login:codex']])
  })

  it('validates an OpenRouter key and reports its credit', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization')
      if (auth !== 'Bearer sk-or-good') return new Response('{}', { status: 401 })
      if (String(url).endsWith('/credits'))
        return Response.json({ data: { total_credits: 10, total_usage: 2.5 } })
      return Response.json({ data: {} })
    }) as unknown as typeof globalThis.fetch
    const handlers = new SetupRoutes({
      store,
      vm: createPlaceholderVm(),
      introduceFirstBot: () => {},
      fetch,
      log: () => {},
    }).handlers()
    expect(await handlers.checkOpenRouterKey({ ...noArgs, body: { apiKey: 'sk-or-good' } })).toEqual({
      valid: true,
      creditUsd: 7.5,
      error: null,
    })
    expect(await handlers.checkOpenRouterKey({ ...noArgs, body: { apiKey: 'sk-or-bad' } })).toEqual({
      valid: false,
      creditUsd: null,
      error: 'invalid_key',
    })
  })
})
