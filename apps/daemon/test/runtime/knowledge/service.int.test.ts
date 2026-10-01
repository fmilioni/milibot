import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type {
  Attachment,
  KnowledgeContent,
  KnowledgeDoc,
  KnowledgeDocList,
  KnowledgeIndexStatus,
  KnowledgeSearchResult,
  Message,
  UploadProgress,
  WorkspaceEvent,
} from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { extractBackupDb, writeBackupZip } from '../../../src/backup/archive'
import type { Db } from '../../../src/db/sqlite'
import { SUMMARY_SYSTEM_PROMPT } from '../../../src/runtime/knowledge/pipeline'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { QemuVmController } from '../../../src/runtime/vm/controller'
import { type FakeGuest, fakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

const SUMMARY = 'Office lease agreement: rent due date, late payment fine and annual adjustment.'

let h: RuntimeHarness
let db: Db
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let guest: FakeGuest
let vm: QemuVmController
let chiefId: string
let chiefDm: string
let provider: FakeProvider
const dir = useTempDir('knowledge')
afterEach(stopRuntimes)

const isSummary = (request: CompletionRequest) =>
  request.messages[0]?.content.some((p) => p.type === 'text' && p.text === SUMMARY_SYSTEM_PROMPT) ?? false

const pdfPages = () => ({
  kind: 'pdf',
  pages: [
    { n: 1, text: 'LEASE AGREEMENT\n\nParties: Ana Souza and Sol Realty.', ocr: false },
    {
      n: 2,
      text: 'Payment\n\nThe rent is due on the fifth of every month. Late payment incurs a fine of two percent a month.',
      ocr: false,
    },
    { n: 3, text: 'Annual adjustment by the IGP-M index in January.', ocr: true },
  ],
  meta: { pageCount: 3, pseudoPages: false, ocrSkipped: [], truncated: false, durationMs: 3 },
})

async function boot(
  chat: (i: number, request: CompletionRequest) => FakeStep,
  options: { autostart?: boolean } = {},
) {
  const pdfGuest = fakeGuest()
  pdfGuest.state.extract = (req) =>
    req.query.name?.endsWith('.pdf')
      ? pdfPages()
      : { error: { code: 'unsupported_format', message: 'no' }, status: 415 }
  let chatCalls = 0
  h = await bootRuntime({
    dir: dir(),
    guest: pdfGuest,
    script: (request) => (isSummary(request) ? { text: SUMMARY } : chat(chatCalls++, request)),
    vm: { autostart: options.autostart ?? true },
  })
  ;({ db, runtime, host, events, guest, provider, botId: chiefId, dm: chiefDm } = h)
  vm = h.vm!
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function upload(name: string, bytes: Uint8Array): Promise<KnowledgeDoc> {
  const up = await call<UploadProgress>('createKnowledgeUpload', {}, { name, size: bytes.length })
  await call(
    'uploadKnowledgeChunk',
    { uploadId: up.id },
    { offset: 0, data: Buffer.from(bytes).toString('base64') },
  )
  return call<KnowledgeDoc>('completeKnowledgeUpload', { uploadId: up.id })
}

const idle = () => runtime.services.knowledge.idle()
const pdf = () => new TextEncoder().encode('%PDF-1.7\nfake contract bytes')

function toolResults(): Array<{ name: string; status: string; text: string }> {
  return (
    db.prepare('SELECT tool_name, status, result_json FROM tool_calls ORDER BY started_at').all() as Array<{
      tool_name: string
      status: string
      result_json: string | null
    }>
  ).map((r) => ({
    name: r.tool_name,
    status: r.status,
    text: (JSON.parse(r.result_json ?? '{}') as { text?: string }).text ?? '',
  }))
}

describe('knowledge base (fake VM, fake LLM, fake embeddings)', () => {
  it('upload → extract → summary → index → search, and the bots use the tools', async () => {
    const steps: FakeStep[] = []
    await boot((i) => steps[i] ?? { text: 'Done.' })
    const doc = await upload('Contract.pdf', pdf())
    const contractId = doc.id
    expect(doc).toMatchObject({ status: 'queued', kind: 'pdf', source: 'upload', authorType: 'user' })
    await idle()

    const ready = await call<KnowledgeDoc>('getKnowledgeDoc', { docId: contractId })
    expect(ready).toMatchObject({ status: 'ready', pages: 3, ocrPages: 1, summary: SUMMARY, embedded: true })
    expect(ready.chunks).toBeGreaterThan(0)
    expect(guest.state.extracts[0]?.query).toMatchObject({ name: 'Contract.pdf', kind: 'pdf' })
    expect(existsSync(join(dir(), 'knowledge', contractId, 'original.pdf'))).toBe(true)
    expect(readFileSync(join(dir(), 'knowledge', contractId, 'content.md'), 'utf8')).toContain(
      '<!-- page 2 -->',
    )
    const purposes = (db.prepare('SELECT purpose FROM llm_calls').all() as Array<{ purpose: string }>).map(
      (r) => r.purpose,
    )
    expect(purposes).toContain('knowledge_summary')
    expect(
      events.some((e) => e.type === 'knowledge.doc.updated' && e.payload.doc.status === 'extracting'),
    ).toBe(true)

    const search = await call<KnowledgeSearchResult>(
      'searchKnowledge',
      {},
      { query: 'late payment fine', topK: 3 },
    )
    expect(search.mode).toBe('hybrid')
    expect(search.hits[0]).toMatchObject({ docId: contractId, title: 'Contract' })
    expect(search.hits[0]?.text).toContain('fine')

    const content = await call<KnowledgeContent>('getKnowledgeContent', { docId: contractId }, undefined, {})
    expect(content).toMatchObject({ part: 1, parts: 1, summary: SUMMARY })
    const exported = await call<{ path: string; fileName: string }>('exportKnowledgeDoc', {
      docId: contractId,
    })
    expect(exported.fileName).toBe('Contract.pdf')
    expect(readFileSync(exported.path)).toEqual(Buffer.from(pdf()))

    const list = await call<KnowledgeDocList>('listKnowledge', {}, undefined, { q: 'office lease' })
    expect(list.docs.map((d) => d.id)).toEqual([contractId])
    expect(list.index).toMatchObject({
      state: 'idle',
      totalChunks: ready.chunks,
      indexedChunks: ready.chunks,
    })

    guest.state.files.set(
      '/workspace/docs/notes.md',
      new TextEncoder().encode('# Notes\n\nAna keeps the key.'),
    )
    steps.push(
      { toolCalls: [{ name: 'knowledge_search', arguments: { query: 'late fine rent' } }] },
      { toolCalls: [{ name: 'knowledge_read', arguments: { doc: contractId, pages: '2' } }] },
      {
        toolCalls: [
          {
            name: 'knowledge_write',
            arguments: {
              title: 'Payment runbook',
              content:
                '# Payment\n\nPay the rent by the 5th by bank transfer.\n\n## Fines\n\nFine of 2% a month.',
              pinned: true,
            },
          },
        ],
      },
      { toolCalls: [{ name: 'knowledge_add', arguments: { path: 'docs/notes.md', scope: 'me' } }] },
      { toolCalls: [{ name: 'memory_save', arguments: { note: 'Contract details: '.repeat(40) } }] },
      { toolCalls: [{ name: 'knowledge_delete', arguments: { doc: 'Contract' } }] },
      { text: 'The fine is 2% a month (Contract, p. 2).' },
    )
    await call(
      'postMessage',
      { conversationId: chiefDm },
      { content: 'what is the late payment fine for the rent?' },
    )
    await host.idle()
    await idle()

    const results = toolResults()
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['knowledge_search', 'ok'],
      ['knowledge_read', 'ok'],
      ['knowledge_write', 'ok'],
      ['knowledge_add', 'ok'],
      ['memory_save', 'error'],
      ['knowledge_delete', 'error'],
    ])
    expect(results[0]?.text).toContain(`[1] Contract · p. 2 (${contractId}, chunk 2)\nPayment`)
    expect(results[1]?.text).toMatch(
      /^# Contract \(pdf, 3 p\., kdoc_\w+\) · p\. 2\n\n--- page 2 ---\nPayment/,
    )
    expect(results[4]?.text).toContain('knowledge_write')
    expect(results[5]?.text).toContain('added by the user')

    const messages = (
      await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
        limit: 50,
      })
    ).messages
    const activity = messages.find((m) => m.kind === 'activity')
    const steps2 = activity?.payload?.type === 'activity' ? activity.payload.steps : []
    expect(steps2.map((s) => [s.kind, s.detail])).toEqual([
      ['knowledge_search', 'late fine rent'],
      ['knowledge_read', '“Contract” p. 2'],
      ['knowledge_write', 'Payment runbook'],
      ['knowledge_add', 'notes'],
      ['memory_save', expect.any(String)],
      ['knowledge_delete', 'Contract'],
    ])

    const all = await call<KnowledgeDocList>('listKnowledge', {}, undefined, {})
    expect(all.total).toBe(3)
    const runbook = all.docs.find((d) => d.title === 'Payment runbook')
    expect(runbook).toMatchObject({
      source: 'bot',
      authorBotId: chiefId,
      kind: 'note',
      pinned: true,
      status: 'ready',
      summary: SUMMARY,
    })
    const notes = all.docs.find((d) => d.source === 'vm_file')
    expect(notes).toMatchObject({ sourceRef: '/workspace/docs/notes.md', kind: 'markdown', scope: [chiefId] })

    // The next turn has the catalog (with the pinned runbook) in the system prompt.
    steps.push({
      toolCalls: [
        {
          name: 'knowledge_edit',
          arguments: { doc: runbook?.id, old_text: 'Fine of 2% a month.', new_text: 'Fine of 3% a month.' },
        },
      ],
    })
    steps.push({ toolCalls: [{ name: 'knowledge_delete', arguments: { doc: runbook?.id } }] })
    steps.push({ text: 'Done.' })
    await call('postMessage', { conversationId: chiefDm }, { content: 'update the fine to 3%' })
    await host.idle()
    await idle()
    const turn = provider.requests.filter((r) => r.tools.length > 0).at(-3)
    const system = (turn?.messages[0]?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    expect(system).toContain('# Knowledge base\n3 general documents')
    expect(system).toContain('- Payment runbook (note)')
    const later = toolResults()
    expect(later.slice(-2).map((r) => [r.name, r.status])).toEqual([
      ['knowledge_edit', 'ok'],
      ['knowledge_delete', 'ok'],
    ])
    expect(existsSync(join(dir(), 'knowledge', runbook!.id))).toBe(false)
    expect(events.some((e) => e.type === 'knowledge.doc.deleted' && e.payload.docId === runbook?.id)).toBe(
      true,
    )

    // Delete from the settings screen removes rows and files.
    await call('deleteKnowledgeDoc', { docId: contractId })
    expect(existsSync(join(dir(), 'knowledge', contractId))).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE doc_id = ?').get(contractId)).toEqual(
      { n: 0 },
    )
  })

  it('queues documents that need the VM and processes text files on the host', async () => {
    await boot(() => ({ text: 'ok' }), { autostart: false })
    const pdfDoc = await upload('Contract.pdf', pdf())
    const text = await upload(
      'notes.txt',
      new TextEncoder().encode('List of the office suppliers and contacts.'),
    )
    await idle()
    expect((await call<KnowledgeDoc>('getKnowledgeDoc', { docId: text.id })).status).toBe('ready')
    expect((await call<KnowledgeDoc>('getKnowledgeDoc', { docId: pdfDoc.id })).status).toBe('queued')
    const index = await call<KnowledgeIndexStatus>('getKnowledgeIndex')
    expect(index).toMatchObject({ pendingDocs: 1, waitingForVm: 1 })

    // A chat attachment still on the host becomes a document too (a copy of its bytes).
    const bytes = new TextEncoder().encode('Meeting minutes: approve the March budget.')
    const attachment = await call<Attachment>(
      'createAttachment',
      { conversationId: chiefDm },
      { name: 'minutes.md', size: bytes.length },
    )
    await call(
      'uploadAttachmentChunk',
      { attachmentId: attachment.id },
      { offset: 0, data: Buffer.from(bytes).toString('base64') },
    )
    await call('completeAttachment', { attachmentId: attachment.id })
    const fromAttachment = await call<KnowledgeDoc>(
      'addKnowledgeFromAttachment',
      {},
      { attachmentId: attachment.id },
    )
    expect(fromAttachment).toMatchObject({ source: 'attachment', sourceRef: attachment.id, kind: 'markdown' })
    expect(
      (await call<KnowledgeDoc>('addKnowledgeFromAttachment', {}, { attachmentId: attachment.id })).id,
    ).toBe(fromAttachment.id)

    await call('startVm')
    await until(() => vm.info().state === 'running')
    await until(() => runtime.services.knowledge.docs.row(pdfDoc.id).status === 'ready')
    await idle()
    expect(guest.state.extracts).toHaveLength(1)
    expect((await call<KnowledgeDoc>('getKnowledgeDoc', { docId: fromAttachment.id })).status).toBe('ready')
  })

  it('reindexes in the background when the model changes, then drops the old vectors', async () => {
    await boot(() => ({ text: 'ok' }))
    const doc = await upload('Contract.pdf', pdf())
    await idle()
    const before = await call<KnowledgeIndexStatus>('getKnowledgeIndex')
    expect(before.activeSpace).toBe('fake:embeddinggemma:max:64')

    await call(
      'updateKnowledgeSettings',
      {},
      { embedding: { provider: 'local', family: 'multilingual-e5', level: 'small' } },
    )
    await idle()
    const after = await call<KnowledgeIndexStatus>('getKnowledgeIndex')
    expect(after).toMatchObject({
      activeSpace: 'fake:multilingual-e5:small:64',
      targetSpace: null,
      state: 'idle',
    })
    const spaces = db.prepare('SELECT DISTINCT space FROM knowledge_vectors').all()
    expect(spaces).toEqual([{ space: 'fake:multilingual-e5:small:64' }])
    const search = await call<KnowledgeSearchResult>(
      'searchKnowledge',
      {},
      { query: 'annual adjustment', topK: 2 },
    )
    expect(search).toMatchObject({ mode: 'hybrid', space: 'fake:multilingual-e5:small:64' })
    expect(search.hits[0]?.docId).toBe(doc.id)
  })

  it('backs up the knowledge files and marks documents without them as failed', async () => {
    await boot(() => ({ text: 'ok' }))
    const doc = await upload('Contract.pdf', pdf())
    await idle()
    const zip = join(dir(), 'backup.zip')
    await writeBackupZip({
      db,
      path: zip,
      workspaceName: 'Test',
      version: 'dev',
      now: Date.now(),
      knowledgeDir: join(dir(), 'knowledge'),
      skillsDir: join(dir(), 'skills'),
    })
    const restored = join(dir(), 'restored')
    mkdirSync(restored)
    await extractBackupDb(zip, join(restored, 'workspace.db'))
    expect(readFileSync(join(restored, 'knowledge', doc.id, 'content.md'), 'utf8')).toContain('fine')
    expect(existsSync(join(restored, 'knowledge', doc.id, 'original.pdf'))).toBe(true)

    // Same database, a workspace folder without the files: the document fails clearly.
    await runtime.stop('keep')
    const empty = join(dir(), 'empty')
    mkdirSync(empty)
    const restarted = createWorkspaceRuntime({
      workspaceId: h.workspaceId,
      workspaceDir: empty,
      db,
      emit: () => undefined,
    })
    await restarted.start()
    try {
      expect(
        await restarted.handle(
          'getKnowledgeDoc',
          { workspaceId: h.workspaceId, docId: doc.id },
          {},
          undefined,
        ),
      ).toMatchObject({ status: 'failed', errorCode: 'file_missing' })
    } finally {
      await restarted.stop('force')
    }
  })
})
