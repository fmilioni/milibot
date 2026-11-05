import type { KnowledgeDoc, UploadProgress } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../support/runtime-harness'
import { useTempDir } from '../support/temp'

const dir = useTempDir('no-computer')
afterEach(stopRuntimes)

const NO_COMPUTER = { code: 'unsupported', details: { reason: 'no_computer' } }

function bootWithoutComputer(script: Parameters<typeof bootRuntime>[0]['script'] = []) {
  return bootRuntime({
    dir: dir(),
    script,
    fallback: { text: 'Summary.' },
    vm: false,
    runtime: { computer: 'none' },
  })
}

async function upload(h: RuntimeHarness, name: string, text: string): Promise<KnowledgeDoc> {
  const bytes = Buffer.from(text)
  const up = await h.call<UploadProgress>('createKnowledgeUpload', {}, { name, size: bytes.length })
  await h.call('uploadKnowledgeChunk', { uploadId: up.id }, { offset: 0, data: bytes.toString('base64') })
  return h.call<KnowledgeDoc>('completeKnowledgeUpload', { uploadId: up.id })
}

describe('a workspace without a computer', () => {
  it('leaves the skills that need a machine out of every catalog, with their tool families', async () => {
    const h = await bootWithoutComputer()
    const bot = h.store.bots.get(h.botId)

    const context = h.runtime.services.skills.skillContext(bot)

    expect(context.capabilities.size).toBe(0)
    for (const skill of ['using-the-screen', 'web-browsing', 'code-and-repos', 'design-to-code', 'slides']) {
      expect(context.catalog).not.toContain(`- ${skill} —`)
    }
    expect(context.catalog).toContain('- boards —')
    for (const family of ['computer', 'browser', 'repos']) {
      expect(context.families.has(family)).toBe(false)
    }
    expect(context.families.has('design')).toBe(true)
  })

  it('offers its bots no machine tools and tells them there is no computer', async () => {
    const h = await bootWithoutComputer([{ text: 'Done.' }])

    await h.call('postMessage', { conversationId: h.dm }, { content: 'hi' })
    await h.host.idle()

    const request = h.provider.requests[0]
    const offered = request?.tools.map((t) => t.name) ?? []
    for (const tool of ['bash', 'file_read', 'computer', 'browser_click', 'share_file', 'vm_status']) {
      expect(offered).not.toContain(tool)
    }
    expect(offered).toEqual(expect.arrayContaining(['web_fetch', 'board_list', 'knowledge_search']))
    const system = request?.messages[0]?.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    expect(system).toContain('## Working without a computer')
  })

  it('refuses to add a CLI engine provider', async () => {
    const h = await bootWithoutComputer()

    await expect(
      h.call('createProvider', {}, { type: 'claude_code', name: 'Claude Code', authMode: 'subscription' }),
    ).rejects.toMatchObject(NO_COMPUTER)
  })

  it('reads text documents into the knowledge base and fails the ones only a computer can read', async () => {
    const h = await bootWithoutComputer()

    const notes = await upload(h, 'notes.md', '# Notes\n\nThe launch is on Friday.')
    const contract = await upload(h, 'contract.pdf', '%PDF-1.7\nfake contract bytes')
    await h.runtime.services.knowledge.idle()

    const doc = (id: string) => h.call<KnowledgeDoc>('getKnowledgeDoc', { docId: id })
    expect((await doc(notes.id)).errorCode).toBeNull()
    expect(await doc(contract.id)).toMatchObject({ status: 'failed', errorCode: 'no_computer' })
  })

  it('runs work sessions without a folder and refuses one asked for', async () => {
    const h = await bootWithoutComputer([
      {
        toolCalls: [{ name: 'session_start', arguments: { title: 'Site', goal: 'Plan it', folder: 'site' } }],
      },
      { toolCalls: [{ name: 'session_start', arguments: { title: 'Site', goal: 'Plan the launch' } }] },
      { text: 'Started.' },
    ])

    await h.call('postMessage', { conversationId: h.dm }, { content: 'plan the launch in a session' })
    await h.host.idle()

    const results = h.db
      .prepare(
        "SELECT status, result_json FROM tool_calls WHERE tool_name = 'session_start' ORDER BY started_at",
      )
      .all() as Array<{ status: string; result_json: string }>
    expect(results.map((r) => r.status)).toEqual(['error', 'ok'])
    expect(results[0]?.result_json).toContain('has no computer')
    const sessions = h.db.prepare('SELECT cwd, repo_name FROM work_sessions').all()
    expect(sessions).toEqual([{ cwd: null, repo_name: null }])
  })

  it('refuses external MCP servers that would run in the VM and keeps remote ones', async () => {
    const h = await bootWithoutComputer()

    await expect(
      h.call('createMcpServer', {}, { name: 'Files', transport: 'stdio_vm', command: 'npx' }),
    ).rejects.toMatchObject(NO_COMPUTER)
    const remote = await h.call<{ transport: string }>(
      'createMcpServer',
      {},
      { name: 'Docs', transport: 'http', url: 'https://mcp.example.com/mcp' },
    )
    expect(remote.transport).toBe('http')
  })

  it('shows attached files by name, with the text of small text files, never a VM path', async () => {
    const h = await bootWithoutComputer([{ text: 'Got it.' }])
    const attach = async (name: string, data: Buffer) => {
      const created = await h.call<{ id: string }>(
        'createAttachment',
        { conversationId: h.dm },
        { name, size: data.length },
      )
      await h.call(
        'uploadAttachmentChunk',
        { attachmentId: created.id },
        { offset: 0, data: data.toString('base64') },
      )
      await h.call('completeAttachment', { attachmentId: created.id })
      return created.id
    }
    const notes = await attach('notes.csv', Buffer.from('month,sales\njan,10\n'))
    const archive = await attach('backup.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))

    await h.call(
      'postMessage',
      { conversationId: h.dm },
      { content: 'see these', attachmentIds: [notes, archive] },
    )
    await h.host.idle()

    const content = h.messages().find((m) => m.authorType === 'user')?.content ?? ''
    expect(content).toContain('[Attached files]')
    expect(content).toContain('- notes.csv')
    expect(content).toContain('- backup.zip')
    expect(content).toContain('--- notes.csv ---\nmonth,sales\njan,10')
    expect(content).not.toContain('/workspace')
    expect(h.provider.requests).toHaveLength(1)
  })

  it('backs up the data only: workspace files are refused up front and estimated as none', async () => {
    const h = await bootWithoutComputer()
    const path = `${dir()}/backup.zip`

    await expect(
      h.call('startBackupJob', {}, { kind: 'archive', path, includeWorkspace: true }),
    ).rejects.toMatchObject(NO_COMPUTER)
    expect(await h.call('estimateBackup', {}, {})).toEqual({ workspaceBytes: 0 })
    expect(await h.call('getBackupJob')).toBeNull()
  })
})
