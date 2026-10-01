import { localEmbeddingSpaceKey, recommendedLocalEmbeddingLevel } from '@milibot/agent/embeddings'
import { FAKE_EMBEDDING_WORKER_URL } from '@milibot/agent/testing'
import {
  type ApiClient,
  type KnowledgeDoc,
  type WorkspaceEvent,
  WorkspaceEventEnvelope,
} from '@milibot/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import type { Supervisor } from '../../src/supervisor/server'
import { startSupervisor } from '../support/supervisor-harness'
import { removeDir, tempDir } from '../support/temp'
const workerUrl = FAKE_EMBEDDING_WORKER_URL

let dataRoot: string
let supervisor: Supervisor
let client: ApiClient
let baseUrl: string
let closed = false
const sockets: WebSocket[] = []

beforeAll(async () => {
  dataRoot = tempDir('shared-embeddings')
  ;({ supervisor, client, baseUrl } = await startSupervisor({
    dataRoot,
    runtimeEnv: { MILIBOT_FAKE_EMBEDDINGS: '' },
    embeddings: { workerUrl, remoteHost: 'slow' },
  }))
})

afterAll(async () => {
  for (const socket of sockets) socket.close()
  if (!closed) await supervisor?.close()
  if (dataRoot) removeDir(dataRoot)
})

function subscribe(workspaceId: string): WorkspaceEvent[] {
  const events: WorkspaceEvent[] = []
  const socket = new WebSocket(
    `${baseUrl.replace('http', 'ws')}/w/${workspaceId}/events?token=${supervisor.token}`,
  )
  socket.on('message', (data) => events.push(WorkspaceEventEnvelope.parse(JSON.parse(String(data))).event))
  sockets.push(socket)
  return events
}

async function upload(workspaceId: string, name: string, text: string): Promise<KnowledgeDoc> {
  const bytes = Buffer.from(text)
  const up = await client.call('createKnowledgeUpload', {
    params: { workspaceId },
    body: { name, size: bytes.length },
  })
  await client.call('uploadKnowledgeChunk', {
    params: { workspaceId, uploadId: up.id },
    body: { offset: 0, data: bytes.toString('base64') },
  })
  return client.call('completeKnowledgeUpload', { params: { workspaceId, uploadId: up.id } })
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('shared embedding model (supervisor)', () => {
  it('indexes two workspaces with one model process, and both see the download', async () => {
    const workspaces = await Promise.all(
      ['Um', 'Dois'].map((name) => client.call('createWorkspace', { body: { name, color: 'violet' } })),
    )
    await Promise.all(workspaces.map((w) => client.call('openWorkspace', { params: { workspaceId: w.id } })))
    const events = workspaces.map((w) => subscribe(w.id))
    await new Promise((r) => setTimeout(r, 100))

    const docs = await Promise.all(
      workspaces.map((w, i) =>
        upload(
          w.id,
          `notes-${i}.md`,
          `# Notes ${i}\n\nContract ${i} is due in March.\n\n## Payment\n\nMonthly.`,
        ),
      ),
    )
    await until(async () => {
      const current = await Promise.all(
        workspaces.map((w, i) =>
          client.call('getKnowledgeDoc', { params: { workspaceId: w.id, docId: docs[i]!.id } }),
        ),
      )
      return current.every((d) => d.status === 'ready')
    })

    const space = localEmbeddingSpaceKey(recommendedLocalEmbeddingLevel())
    for (const w of workspaces) {
      const index = await client.call('getKnowledgeIndex', { params: { workspaceId: w.id } })
      expect(index).toMatchObject({ activeSpace: space })
    }
    for (const list of events) {
      const downloading = list.filter(
        (e) => e.type === 'knowledge.index.status' && e.payload.status.state === 'downloading',
      )
      expect(downloading.length).toBeGreaterThan(0)
    }
    expect(supervisor.embeddingModels.spawnCount()).toBe(1)
    expect(supervisor.embeddingModels.runningProcesses()).toBe(1)

    const search = await client.call('searchKnowledge', {
      params: { workspaceId: workspaces[1]!.id },
      body: { query: 'when is the contract due' },
    })
    expect(search).toMatchObject({ mode: 'hybrid', space })
    expect(search.hits.length).toBeGreaterThan(0)
    expect(supervisor.embeddingModels.spawnCount()).toBe(1)

    const [pid] = supervisor.embeddingModels.pids()
    closed = true
    await supervisor.close()
    expect(() => process.kill(pid!, 0)).toThrow()
  }, 60_000)
})
