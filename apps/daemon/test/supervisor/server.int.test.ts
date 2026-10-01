import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { type ApiClient, ApiError, createApiClient, type WorkspaceSummary } from '@milibot/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { writeBackupZip } from '../../src/backup/archive'
import { WorkspaceStore } from '../../src/runtime/workspace-store'
import type { MemorySecretStore } from '../../src/secrets/secret-store'
import type { Supervisor } from '../../src/supervisor/server'
import { openWorkspaceDb } from '../../src/workspace-db/open'
import { seedWorkspace } from '../../src/workspace-db/seed'
import { startSupervisor, subscribeWorkspace, type SupervisorHarness } from '../support/supervisor-harness'
import { removeDir, tempDir } from '../support/temp'

let dataRoot: string
let harness: SupervisorHarness
let supervisor: Supervisor
let secrets: MemorySecretStore
let client: ApiClient
let baseUrl: string
const shutdownRequests: string[] = []

const subscribe = (workspaceId: string) => subscribeWorkspace(harness, workspaceId)

async function waitForMessages(workspaceId: string, conversationId: string, count: number) {
  const deadline = Date.now() + 5_000
  for (;;) {
    const page = await client.call('listMessages', {
      params: { workspaceId, conversationId },
      query: { limit: 50 },
    })
    if (page.messages.length >= count || Date.now() > deadline) return page.messages
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  dataRoot = tempDir('int')
  harness = await startSupervisor({
    dataRoot,
    secretStoreInfo: { kind: 'memory', warning: null, detail: null },
    requestShutdown: (reason) => shutdownRequests.push(reason),
  })
  ;({ supervisor, secrets, client, baseUrl } = harness)
})

afterAll(async () => {
  await harness?.close()
  if (dataRoot) removeDir(dataRoot)
})

describe('supervisor', () => {
  let workspace: WorkspaceSummary

  it('rejects requests without the token', async () => {
    const res = await fetch(`${baseUrl}/workspaces`)
    expect(res.status).toBe(401)
    const bad = createApiClient({ baseUrl, token: 'wrong' })
    await expect(bad.call('listWorkspaces', {})).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('reports the secret store and asks for a shutdown after answering POST /shutdown', async () => {
    const host = await client.call('getHostInfo', {})
    expect(host.secretStore).toBe('memory')
    expect(host.platform).toEqual({ os: process.platform, arch: process.arch })
    expect(host.vmAccel?.kind).toMatch(/^(hvf|kvm|whpx|tcg)$/)
    // The Windows Hypervisor Platform check shapes vmAccel; there is no separate field.
    expect(host).not.toHaveProperty('windowsHypervisor')
    const unauthorized = await fetch(`${baseUrl}/shutdown`, { method: 'POST' })
    expect(unauthorized.status).toBe(401)
    expect(shutdownRequests).toEqual([])
    await expect(client.call('shutdown', {})).resolves.toEqual({ ok: true })
    for (let i = 0; i < 50 && !shutdownRequests.length; i++) await new Promise((r) => setTimeout(r, 10))
    expect(shutdownRequests).toEqual(['api'])
  })

  it('answers health checks', async () => {
    const health = await client.call('health', {})
    expect(health.pid).toBe(process.pid)
  })

  it('creates a workspace with its directory and database', async () => {
    workspace = await client.call('createWorkspace', { body: { name: 'Personal', color: 'violet' } })
    expect(workspace).toMatchObject({
      name: 'Personal',
      runtimeStatus: 'stopped',
      closeBehavior: 'keep_running',
    })
    expect(workspace.dir.startsWith(dataRoot)).toBe(true)
    expect(existsSync(join(workspace.dir, 'workspace.db'))).toBe(true)
    expect(await client.call('listWorkspaces', {})).toHaveLength(1)
  })

  it('opens the workspace runtime and serves the seeded first bot and its DM', async () => {
    const opened = await client.call('openWorkspace', { params: { workspaceId: workspace.id } })
    expect(opened.runtimeStatus).toBe('running')
    expect(opened.lastOpenedAt).not.toBeNull()

    const bots = await client.call('listBots', { params: { workspaceId: workspace.id } })
    expect(bots).toHaveLength(1)
    // Portuguese on purpose: the first bot is seeded in the app language (pt-BR by default).
    expect(bots[0]).toMatchObject({ name: 'Maestro', label: 'Equipe' })

    const conversations = await client.call('listConversations', { params: { workspaceId: workspace.id } })
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({ type: 'direct', memberBotIds: [bots[0]?.id] })
  })

  it("gives running runtimes the app's new language as the user's language", async () => {
    const params = { workspaceId: workspace.id }
    expect(await client.call('getWorkspacePreferences', { params })).toMatchObject({ userLanguage: 'pt-BR' })
    await client.call('updateAppSettings', { body: { language: 'en' } })
    try {
      const deadline = Date.now() + 5_000
      while ((await client.call('getWorkspacePreferences', { params })).userLanguage !== 'en') {
        if (Date.now() > deadline) throw new Error('language not shared')
        await new Promise((r) => setTimeout(r, 20))
      }
    } finally {
      await client.call('updateAppSettings', { body: { language: 'pt-BR' } })
    }
  })

  it('persists user messages and streams events', async () => {
    const stream = subscribe(workspace.id)
    await stream.opened
    await stream.waitFor('runtime.status')

    const [conversation] = await client.call('listConversations', { params: { workspaceId: workspace.id } })
    if (!conversation) throw new Error('missing conversation')
    const message = await client.call('postMessage', {
      params: { workspaceId: workspace.id, conversationId: conversation.id },
      body: { content: 'Hello there!' },
    })
    expect(message).toMatchObject({ authorType: 'user', content: 'Hello there!' })

    const event = await stream.waitFor('message.created')
    expect(event.payload.message.id).toBe(message.id)

    const page = await client.call('listMessages', {
      params: { workspaceId: workspace.id, conversationId: conversation.id },
      query: { limit: 10 },
    })
    expect(page.messages[0]?.content).toBe('Hello there!')

    // Without a configured provider the bot answers with an error card instead of hanging.
    const reply = await waitForMessages(workspace.id, conversation.id, 2)
    expect(reply[1]).toMatchObject({ kind: 'card', payload: { type: 'error', code: 'no_provider' } })
    stream.socket.close()
  })

  it('validates request bodies in the runtime', async () => {
    const [conversation] = await client.call('listConversations', { params: { workspaceId: workspace.id } })
    const err = await client
      .call('postMessage', {
        params: { workspaceId: workspace.id, conversationId: conversation?.id ?? '' },
        body: { content: '   ' },
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'validation_failed', status: 400 })
  })

  it('creates a bot together with its direct conversation', async () => {
    const stream = subscribe(workspace.id)
    await stream.opened
    const created = await client.call('createBot', {
      params: { workspaceId: workspace.id },
      body: { name: 'Analyst', label: 'Finance' },
    })
    expect(created.bot.linuxUid).toBe(2002)
    expect(created.conversation.memberBotIds).toEqual([created.bot.id])
    expect((await stream.waitFor('bot.created')).payload.bot.id).toBe(created.bot.id)
    stream.socket.close()
  })

  it('restarts a crashed runtime on the next request', async () => {
    const statusStream = subscribe(workspace.id)
    await statusStream.opened
    const pid = supervisor.runtimes.pid(workspace.id)
    if (!pid) throw new Error('runtime pid not found')
    process.kill(pid, 'SIGKILL')
    await expect.poll(() => supervisor.runtimes.status(workspace.id)).toBe('crashed')
    const bots = await client.call('listBots', { params: { workspaceId: workspace.id } })
    expect(bots.length).toBe(2)
    expect(supervisor.runtimes.status(workspace.id)).toBe('running')
    statusStream.socket.close()
  })

  it('returns 404 for unknown workspaces', async () => {
    await expect(client.call('listBots', { params: { workspaceId: 'ws_missing' } })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('deletes a workspace, its runtime, files and secrets', async () => {
    await secrets.set(workspace.id, 'provider/x/api_key', 'secret')
    await client.call('deleteWorkspace', { params: { workspaceId: workspace.id } })
    expect(existsSync(workspace.dir)).toBe(false)
    expect(await secrets.list(workspace.id)).toEqual([])
    expect(await client.call('listWorkspaces', {})).toEqual([])
    expect(supervisor.runtimes.status(workspace.id)).toBe('stopped')
  })
})

describe('importing a backup', () => {
  it('creates a new workspace from a backup zip that starts at the setup', async () => {
    const db = openWorkspaceDb(':memory:')
    const store = new WorkspaceStore(db)
    seedWorkspace(store, 'en')
    store.bots.create({ name: 'Iris', label: 'Research', systemPrompt: 'Researches things.' })
    const path = join(dataRoot, 'backup.zip')
    await writeBackupZip({
      db,
      path,
      workspaceName: 'Work',
      version: 'dev',
      now: Date.now(),
      knowledgeDir: join(dataRoot, 'no-knowledge'),
      skillsDir: join(dataRoot, 'no-skills'),
    })

    expect(await client.call('inspectBackup', { body: { path } })).toMatchObject({
      workspaceName: 'Work',
      bots: 2,
      workspaceBytes: null,
    })
    const imported = await client.call('importWorkspace', { body: { path, name: 'Work', color: 'teal' } })
    expect(imported).toMatchObject({ name: 'Work', setup: 'providers' })
    const bots = await client.call('listBots', { params: { workspaceId: imported.id } })
    expect(bots.map((b) => b.name).sort()).toEqual(['Iris', 'Maestro'])
    expect(await client.call('getBackupRestore', { params: { workspaceId: imported.id } })).toBeNull()

    await expect(
      client.call('importWorkspace', {
        body: { path: join(dataRoot, 'nope.zip'), name: 'X', color: 'teal' },
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect((await client.call('listWorkspaces', {})).map((w) => w.name)).toEqual(['Work'])
    await client.call('deleteWorkspace', { params: { workspaceId: imported.id } })
  })

  it('tells a backup from a newer app apart from one it cannot open', async () => {
    const importDb = async (name: string, change: (db: ReturnType<typeof openWorkspaceDb>) => void) => {
      const db = openWorkspaceDb(':memory:')
      seedWorkspace(new WorkspaceStore(db), 'en')
      change(db)
      const path = join(dataRoot, `${name}.zip`)
      await writeBackupZip({
        db,
        path,
        workspaceName: name,
        version: 'dev',
        now: Date.now(),
        knowledgeDir: join(dataRoot, 'no-knowledge'),
        skillsDir: join(dataRoot, 'no-skills'),
      })
      return client.call('importWorkspace', { body: { path, name, color: 'teal' } })
    }
    await expect(importDb('newer', (db) => db.pragma('user_version = 999'))).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'newer_version' },
    })
    await expect(importDb('broken', (db) => db.exec('DROP TABLE sidebar_sections'))).rejects.toMatchObject({
      code: 'validation_failed',
      details: { reason: 'not_a_backup' },
    })
    expect(await client.call('listWorkspaces', {})).toEqual([])
  })
})
