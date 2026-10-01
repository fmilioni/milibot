import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type AppEvent, AppEventEnvelope, EVENTS_PATH, type VmState } from '@milibot/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { startSupervisor, type SupervisorHarness } from '../support/supervisor-harness'
import { removeDir, tempDir } from '../support/temp'
import { until } from '../support/wait'

let dataRoot: string
let harness: SupervisorHarness
let socket: WebSocket
const appEvents: AppEvent[] = []

beforeAll(async () => {
  dataRoot = tempDir('vm-state')
  const failingCli = join(dataRoot, 'failing-vm-cli.sh')
  writeFileSync(failingCli, `echo '{"ok":false,"error":{"code":"FAKE_FAILURE","message":"fake"}}'\nexit 1\n`)
  harness = await startSupervisor({
    dataRoot,
    runtimeEnv: {
      MILIBOT_VM_DISABLED: '0',
      MILIBOT_VM_AUTOSTART: '0',
      MILIBOT_VM_CLI: failingCli,
      MILIBOT_GOLDEN_IMAGE: join(dataRoot, 'missing-golden.qcow2'),
    },
  })
  socket = new WebSocket(
    `${harness.baseUrl.replace('http', 'ws')}${EVENTS_PATH}?token=${harness.supervisor.token}`,
  )
  socket.on('message', (data) => appEvents.push(AppEventEnvelope.parse(JSON.parse(String(data))).event))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
})

afterAll(async () => {
  socket?.close()
  await harness?.close()
  if (dataRoot) removeDir(dataRoot)
})

const publishedVmStates = (workspaceId: string): VmState[] =>
  appEvents.flatMap((e) =>
    e.type === 'workspace.updated' && e.payload.workspace.id === workspaceId
      ? [e.payload.workspace.vmState]
      : [],
  )

describe('workspace summaries carry the VM state', () => {
  it("reads it from the workspace's files while no runtime runs", async () => {
    const { client } = harness
    const workspace = await client.call('createWorkspace', { body: { name: 'Files', color: 'violet' } })
    expect(workspace.vmState).toBe('not_created')

    mkdirSync(join(workspace.dir, 'vm'))
    writeFileSync(join(workspace.dir, 'vm', 'config.json'), JSON.stringify({ cpus: 2 }))
    const listed = (await client.call('listWorkspaces', {})).find((w) => w.id === workspace.id)
    expect(listed?.vmState).toBe('stopped')
  })

  it("publishes each change of a running runtime's VM state to the app socket", async () => {
    const { client } = harness
    const workspace = await client.call('createWorkspace', { body: { name: 'Live', color: 'blue' } })
    await client.call('openWorkspace', { params: { workspaceId: workspace.id } })

    await client.call('startVm', { params: { workspaceId: workspace.id } })
    await until(() => publishedVmStates(workspace.id).includes('error'))

    const published = publishedVmStates(workspace.id)
    expect(published.slice(published.indexOf('starting'))).toEqual(['starting', 'error'])
    const listed = (await client.call('listWorkspaces', {})).find((w) => w.id === workspace.id)
    expect(listed?.vmState).toBe('error')
  })
})
