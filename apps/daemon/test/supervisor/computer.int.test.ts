import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ApiError, type WorkspaceSummary } from '@milibot/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startSupervisor, type SupervisorHarness } from '../support/supervisor-harness'
import { removeDir, tempDir } from '../support/temp'
import { until } from '../support/wait'

/** Records every call and fails, so a VM never runs. */
const FAKE_VM_CLI = `echo "$*" >> "$(dirname "$0")/vm-cli-calls"
echo '{"ok":false,"error":{"code":"FAKE_FAILURE","message":"fake"}}'
exit 1
`

/** Fails: the golden image stays missing. */
const FAKE_BUILD = `#!/bin/bash
exit 1
`

const SYSTEM_DISK_BYTES = 3000
const DATA_DISK_BYTES = 5000

let dataRoot: string
let harness: SupervisorHarness
const savedEnv = { ...process.env }

beforeAll(async () => {
  dataRoot = tempDir('computer')
  const vmCli = join(dataRoot, 'fake-vm-cli.sh')
  writeFileSync(vmCli, FAKE_VM_CLI)
  const build = join(dataRoot, 'fake-build.sh')
  writeFileSync(build, FAKE_BUILD, { mode: 0o755 })
  const fakeLlm = join(dataRoot, 'fake-llm.json')
  writeFileSync(fakeLlm, JSON.stringify([{ text: 'Hi! I am your first bot.' }]))
  process.env.MILIBOT_VM_BUILD = build
  process.env.MILIBOT_GOLDEN_IMAGE = join(dataRoot, 'images', 'debian13-golden.qcow2')
  process.env.MILIBOT_FAKE_LLM = fakeLlm
  harness = await startSupervisor({
    dataRoot,
    runtimeEnv: { MILIBOT_VM_DISABLED: '0', MILIBOT_VM_CLI: vmCli },
  })
})

afterAll(async () => {
  await harness?.close()
  process.env = savedEnv
  if (dataRoot) {
    removeDir(dataRoot)
  }
})

/** The VM CLI calls about one workspace (every command names its folder). */
const vmCliCallsFor = (workspace: WorkspaceSummary): string[] => {
  const path = join(dataRoot, 'vm-cli-calls')
  const calls = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : []
  return calls.filter((call) => call.includes(workspace.dir))
}

function writeFakeVm(workspace: WorkspaceSummary): void {
  const vmDir = join(workspace.dir, 'vm')
  mkdirSync(vmDir, { recursive: true })
  writeFileSync(join(vmDir, 'config.json'), JSON.stringify({ cpus: 2, memGb: 4, dataGb: 40 }))
  writeFileSync(join(vmDir, 'system.qcow2'), Buffer.alloc(SYSTEM_DISK_BYTES))
  writeFileSync(join(vmDir, 'data.qcow2'), Buffer.alloc(DATA_DISK_BYTES))
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  if (!(error instanceof ApiError)) {
    throw new Error(`expected an ApiError, got ${String(error)}`)
  }

  return error
}

describe('a workspace without a computer', () => {
  it('goes through the setup without building the golden image or calling the VM CLI', async () => {
    const { client } = harness
    const workspace = await client.call('createWorkspace', {
      body: { name: 'Light', color: 'teal', setup: true },
    })
    expect(workspace.computer).toBe('vm')
    const params = { workspaceId: workspace.id }

    const configured = await client.call('setupWorkspaceComputer', { params, body: { kind: 'none' } })

    expect(configured).toMatchObject({ computer: 'none', setup: 'vm' })
    expect((await client.call('getGoldenImage', {})).state).toBe('missing')

    const done = await client.call('updateWorkspaceSetup', { params, body: { step: 'done' } })
    expect(done.setup).toBe('done')
    const [firstBot] = await client.call('listBots', { params })
    const dm = (await client.call('listConversations', { params })).find((c) =>
      c.memberBotIds.includes(firstBot?.id ?? ''),
    )
    const introduced = async () => {
      const page = await client.call('listMessages', {
        params: { ...params, conversationId: dm?.id ?? '' },
        query: { limit: 10 },
      })
      return page.messages.some((m) => m.authorBotId === firstBot?.id && m.content.includes('first bot'))
    }
    await until(introduced, 10_000, 50)
    expect(vmCliCallsFor(workspace)).toEqual([])
  })

  it('leaves the VM keeping its disks, and refuses to start it', async () => {
    const { client } = harness
    const workspace = await client.call('createWorkspace', { body: { name: 'Switch', color: 'blue' } })
    writeFakeVm(workspace)
    const params = { workspaceId: workspace.id }
    await client.call('openWorkspace', { params })

    const switched = await client.call('setWorkspaceComputer', { params, body: { kind: 'none' } })

    expect(switched.computer).toBe('none')
    expect((await client.call('listWorkspaces', {})).find((w) => w.id === workspace.id)?.computer).toBe(
      'none',
    )
    const refused = await rejection(client.call('startVm', { params }))
    expect(refused.code).toBe('unsupported')
    expect(refused.details).toEqual({ reason: 'no_computer' })
    expect(existsSync(join(workspace.dir, 'vm', 'data.qcow2'))).toBe(true)
  })

  it('deletes the disks only once the workspace left its VM, reporting the space freed', async () => {
    const { client } = harness
    const workspace = await client.call('createWorkspace', { body: { name: 'Disks', color: 'pink' } })
    writeFakeVm(workspace)
    const params = { workspaceId: workspace.id }

    const stillVm = await rejection(client.call('deleteWorkspaceVm', { params }))
    expect(stillVm.code).toBe('conflict')

    await client.call('setWorkspaceComputer', { params, body: { kind: 'none' } })
    const deleted = await client.call('deleteWorkspaceVm', { params })

    expect(deleted.freedBytes).toBeGreaterThanOrEqual(SYSTEM_DISK_BYTES + DATA_DISK_BYTES)
    expect(existsSync(join(workspace.dir, 'vm'))).toBe(false)
    const [overview] = (await client.call('listWorkspaceOverviews', {})).filter((o) => o.id === workspace.id)
    expect(overview).toMatchObject({ vmState: 'not_created', diskUsedBytes: null })
  })

  it('switches back to a VM, building the missing golden image first', async () => {
    const { client } = harness
    const workspace = await client.call('createWorkspace', {
      body: { name: 'Back', color: 'violet', computer: 'none' },
    })
    const params = { workspaceId: workspace.id }
    expect((await client.call('getGoldenImage', {})).state).toBe('missing')

    const switched = await client.call('setWorkspaceComputer', {
      params,
      body: { kind: 'vm', size: { cpus: 2, memGb: 4, dataGb: 40 } },
    })

    expect(switched.computer).toBe('vm')
    const buildRan = async () => (await client.call('getGoldenImage', {})).state === 'failed'
    await until(buildRan, 10_000, 50)
    // The new runtime waits for the image instead of booting on start.
    expect((await client.call('getVm', { params })).state).toBe('not_created')
    expect(vmCliCallsFor(workspace)).toEqual([])
    expect(await client.call('startVm', { params })).toMatchObject({ state: expect.any(String) })
  })

  it('refuses switching while the workspace is still being set up', async () => {
    const { client } = harness
    const workspace = await client.call('createWorkspace', {
      body: { name: 'Early', color: 'amber', setup: true },
    })

    const refused = await rejection(
      client.call('setWorkspaceComputer', { params: { workspaceId: workspace.id }, body: { kind: 'none' } }),
    )

    expect(refused.code).toBe('conflict')
  })
})
