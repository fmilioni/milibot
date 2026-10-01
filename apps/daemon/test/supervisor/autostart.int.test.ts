import type { CloseBehavior } from '@milibot/shared'
import { afterAll, describe, expect, it } from 'vitest'

import { MemorySecretStore } from '../../src/secrets/secret-store'
import { startSupervisor, type SupervisorHarness } from '../support/supervisor-harness'
import { removeDir, tempDir } from '../support/temp'

const dataRoot = tempDir('autostart')
const secrets = new MemorySecretStore()
const open: SupervisorHarness[] = []

async function start(): Promise<SupervisorHarness> {
  const harness = await startSupervisor({ dataRoot, secrets })
  open.push(harness)
  return harness
}

afterAll(async () => {
  for (const harness of open) await harness.close().catch(() => undefined)
  removeDir(dataRoot)
})

describe('runtime auto-start', () => {
  it('starts the runtimes of the previous session that work in the background', async () => {
    const first = await start()
    const create = (name: string, closeBehavior: CloseBehavior) =>
      first.client.call('createWorkspace', { body: { name, color: 'violet', closeBehavior } })
    const keep = await create('Keep', 'keep_running')
    const routines = await create('Routines', 'suspend_vm')
    const idle = await create('Idle', 'suspend_vm')
    const neverOpened = await create('Never opened', 'keep_running')
    for (const ws of [keep, routines, idle])
      await first.client.call('openWorkspace', { params: { workspaceId: ws.id } })
    const [chief] = await first.client.call('listBots', { params: { workspaceId: routines.id } })
    await first.client.call('createRoutine', {
      params: { workspaceId: routines.id, botId: chief!.id },
      body: { name: 'Morning', prompt: 'Check the news', cron: '0 8 * * *' },
    })
    await first.supervisor.close()
    open.splice(0)

    const second = await start()
    const started = await second.supervisor.autoStartRuntimes()
    expect(new Set(started)).toEqual(new Set([keep.id, routines.id]))
    const status = async (id: string) =>
      (await second.client.call('listWorkspaces', {})).find((w) => w.id === id)?.runtimeStatus
    expect(await status(keep.id)).toBe('running')
    expect(await status(routines.id)).toBe('running')
    expect(await status(idle.id)).toBe('stopped')
    expect(await status(neverOpened.id)).toBe('stopped')
    await second.supervisor.close()
    open.splice(0)

    // "Idle" was not running in the second session, so it stays off; the others start again.
    const third = await start()
    expect(new Set(await third.supervisor.autoStartRuntimes())).toEqual(new Set([keep.id, routines.id]))
  })
})
