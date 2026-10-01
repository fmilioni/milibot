import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAgentHost } from '@milibot/agent'
import { FakeProvider } from '@milibot/agent/testing'
import { PREFERENCE_SETTING_KEYS } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { readRuntimeConfig } from '../../src/config/env'
import { RUNTIME_ENV } from '../../src/ipc/protocol'
import { createRuntimeFromConfig, type RuntimeProcess } from '../../src/runtime/process'
import { MemorySecretStore } from '../../src/secrets/secret-store'
import { fakeGuest } from '../support/fake-guest'
import { FakeVmCli } from '../support/fake-vm-cli'
import { useTempDir } from '../support/temp'
import { until } from '../support/wait'

const dir = useTempDir('process')
let proc: RuntimeProcess | null = null

afterEach(async () => {
  await proc?.stop('force')
  proc = null
})

function start(env: Record<string, string>) {
  const workspaceDir = join(dir(), 'workspaces', 'ws_proc')
  mkdirSync(workspaceDir, { recursive: true })
  const golden = join(dir(), 'golden.qcow2')
  writeFileSync(golden, '')
  const config = readRuntimeConfig({
    MILIBOT_DATA_DIR: dir(),
    MILIBOT_GOLDEN_IMAGE: golden,
    [RUNTIME_ENV.workspaceId]: 'ws_proc',
    [RUNTIME_ENV.workspaceDir]: workspaceDir,
    [RUNTIME_ENV.language]: 'en',
    [RUNTIME_ENV.vmPortBase]: '47500',
    ...env,
  })
  const cli = new FakeVmCli()
  proc = createRuntimeFromConfig(config, {
    vmCli: cli,
    vm: { guestFactory: fakeGuest().client, pollIntervalMs: 5 },
    agentHost: createAgentHost({ deltaFlushMs: 1 }),
    secrets: new MemorySecretStore(),
    runtime: { llm: new FakeProvider({ script: [] }) },
  })
  return { proc, cli }
}

describe('a runtime built from its environment', () => {
  it('boots the workspace VM through the VM CLI and serves its routes', async () => {
    const { proc, cli } = start({})
    await proc.start()
    await until(() => proc.vm.info().state === 'running', 8000)
    expect(cli.calls.map(([command]) => command)).toContain('create')
    expect(await proc.runtime.handle('getVm', { workspaceId: 'ws_proc' }, {}, undefined)).toMatchObject({
      state: 'running',
    })
    const [bot] = proc.runtime.store.bots.list()
    expect(bot?.name).toBeTruthy()
  })

  it('leaves a suspended workspace VM off in the background until a window opens it', async () => {
    const { proc } = start({ [RUNTIME_ENV.background]: '1', [RUNTIME_ENV.closeBehavior]: 'suspend_vm' })
    await proc.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(proc.vm.info().state).not.toBe('running')
    proc.opened()
    await until(() => proc.vm.info().state === 'running', 8000)
  })

  it('leaves the VM off on start and open when the workspace turned autostart off', async () => {
    const { proc, cli } = start({ [RUNTIME_ENV.background]: '1' })
    proc.runtime.store.settings.set(PREFERENCE_SETTING_KEYS.vmAutostart, false)
    await proc.start()
    proc.opened()
    await new Promise((r) => setTimeout(r, 50))
    expect(proc.vm.info().state).not.toBe('running')
    expect(cli.calls).toEqual([])
  })

  it('runs without a VM when it is disabled', async () => {
    const { proc, cli } = start({ MILIBOT_VM_DISABLED: '1' })
    await proc.start()
    expect(proc.vm.info().state).toBe('not_created')
    expect(cli.calls).toEqual([])
  })
})
