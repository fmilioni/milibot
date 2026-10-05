import { createServer, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import type {
  BotMcpServer,
  LlmCallRow,
  McpServer,
  McpTestResult,
  McpTool,
  Message,
  ToolCallRow,
  WorkspaceEvent,
} from '@milibot/shared'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { MemorySecretStore } from '../../../src/secrets/secret-store'
import { buildServer } from '../../fixtures/mcp-test-server.mjs'
import type { FakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const FIXTURE = fileURLToPath(new URL('../../fixtures/mcp-test-server.mjs', import.meta.url))
const SECRET = 'tok_super_secret_123'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let guest: FakeGuest
let secrets: MemorySecretStore
let chiefId: string
let chiefDm: string
let requests: CompletionRequest[]
let http: Server | null = null

const dir = useTempDir('mcp')
afterEach(async () => {
  await stopRuntimes()
  for (const proc of guest?.state.procs.values() ?? []) proc.child.kill('SIGKILL')
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
  http = null
})

type Step = { text?: string; toolCalls?: Array<{ name: string; arguments?: unknown }> }

async function boot(script: Step[] = [{ text: 'ok' }]) {
  requests = []
  h = await bootRuntime({
    dir: dir(),
    host: { compaction: false },
    script: (request) => {
      if (request.tools.length === 0) return { text: 'Hi!' }
      requests.push(request)
      return script[requests.length - 1] ?? { text: 'Done.' }
    },
  })
  ;({ runtime, host, events, guest, secrets, botId: chiefId, dm: chiefDm } = h)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

const stdioBody = (extra: Record<string, unknown> = {}) => ({
  name: 'Test',
  transport: 'stdio_vm',
  command: process.execPath,
  args: [FIXTURE, 'stdio'],
  env: [
    { name: 'TEST_TOKEN', value: SECRET, secret: true },
    { name: 'MODE', value: 'dev', secret: false },
  ],
  ...extra,
})

async function startHttp(token: string, intercept?: (res: ServerResponse) => boolean): Promise<string> {
  http = createServer((req, res) => {
    if (intercept?.(res)) return
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    void server.connect(transport).then(() => transport.handleRequest(req, res))
  })
  await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}/mcp`
}

describe('external MCP servers', () => {
  it('stores secrets in the SecretStore, masks them and tests a stdio server in the VM', async () => {
    await boot()
    const draft = await call<McpTestResult>('testMcpDraft', {}, { config: stdioBody() })
    expect(draft.error).toBeNull()
    expect(draft.tools.map((t) => t.name).sort()).toEqual(['add', 'echo', 'whoami'])
    expect(draft.tools[0]?.tokens).toBeGreaterThan(0)
    const procs = [...guest.state.procs.values()]
    expect(procs[0]).toMatchObject({ label: 'mcp:test', env: { TEST_TOKEN: SECRET, MODE: 'dev' } })

    const created = await call<McpServer>('createMcpServer', {}, stdioBody())
    expect(created).toMatchObject({ slug: 'test', transport: 'stdio_vm', enabled: true, allowedBots: 'all' })
    expect(created.env).toEqual([
      { name: 'TEST_TOKEN', value: null, secret: true, hasValue: true },
      { name: 'MODE', value: 'dev', secret: false, hasValue: true },
    ])
    expect(JSON.stringify(created)).not.toContain(SECRET)
    expect(await secrets.get(h.workspaceId, `mcp.${created.id}.env.TEST_TOKEN`)).toBe(SECRET)
    const row = runtime.store.db.prepare('SELECT env FROM mcp_servers WHERE id = ?').get(created.id) as {
      env: string
    }
    expect(row.env).not.toContain(SECRET)

    const tested = await call<McpTestResult>('testMcpServer', { serverId: created.id })
    expect(tested.ok).toBe(true)
    expect(tested.tools).toHaveLength(3)
    const listed = await call<McpServer[]>('listMcpServers')
    expect(listed[0]?.state.status).toBe('connected')
    expect(listed[0]?.tools.map((t) => t.name).sort()).toEqual(['add', 'echo', 'whoami'])
    expect(await call<McpTool[]>('listMcpTools', { serverId: created.id })).toHaveLength(3)
    const updates = events.filter((e) => e.type === 'mcp.server.updated')
    expect(
      updates.map((e) => (e.type === 'mcp.server.updated' ? e.payload.server.state.status : '')),
    ).toContain('connected')

    // Editing with the secret left blank keeps it; renaming never changes the slug.
    const renamed = await call<McpServer>(
      'updateMcpServer',
      { serverId: created.id },
      { name: 'Test 2', env: [{ name: 'TEST_TOKEN', secret: true }] },
    )
    expect(renamed.slug).toBe('test')
    expect(await secrets.get(h.workspaceId, `mcp.${created.id}.env.TEST_TOKEN`)).toBe(SECRET)
    expect(renamed.env).toEqual([{ name: 'TEST_TOKEN', value: null, secret: true, hasValue: true }])

    await call('deleteMcpServer', { serverId: created.id })
    expect(await secrets.get(h.workspaceId, `mcp.${created.id}.env.TEST_TOKEN`)).toBeNull()
    expect(await call<McpServer[]>('listMcpServers')).toEqual([])
    expect(events.some((e) => e.type === 'mcp.server.deleted')).toBe(true)
  })

  it('connects to a remote server over streamable HTTP with a secret header', async () => {
    await boot()
    const url = await startHttp('abc123token')
    const bad = await call<McpTestResult>(
      'testMcpDraft',
      {},
      { config: { name: 'Remote', transport: 'http', url, headers: [] } },
    )
    expect(bad.ok).toBe(false)
    expect(bad.error).toBeTruthy()
    const server = await call<McpServer>(
      'createMcpServer',
      {},
      {
        name: 'Remote',
        transport: 'http',
        url,
        headers: [{ name: 'Authorization', value: 'Bearer abc123token', secret: true }],
      },
    )
    const result = await call<McpTestResult>('testMcpServer', { serverId: server.id })
    expect(result.error).toBeNull()
    expect(result.tools.map((t) => t.name).sort()).toEqual(['add', 'echo', 'whoami'])
    // An unsaved edit reuses the stored secret header.
    const edited = await call<McpTestResult>(
      'testMcpDraft',
      {},
      {
        serverId: server.id,
        config: {
          name: 'Remote',
          transport: 'http',
          url,
          headers: [{ name: 'Authorization', secret: true }],
        },
      },
    )
    expect(edited.ok).toBe(true)
  })

  it('redacts a token the server echoes without its auth scheme', async () => {
    await boot([{ toolCalls: [{ name: 'mcp__echo__add', arguments: { a: 1, b: 2 } }] }, { text: 'Failed.' }])
    const token = 'qa_draft_secret_558'
    let rejecting = false
    const url = await startHttp(token, (res) => {
      if (!rejecting) return false
      res.writeHead(500, { 'content-type': 'text/plain' }).end(`invalid token ${token}`)
      return true
    })
    const server = await call<McpServer>(
      'createMcpServer',
      {},
      {
        name: 'Echo',
        transport: 'http',
        url,
        headers: [{ name: 'Authorization', value: `Bearer ${token}`, secret: true }],
      },
    )
    expect((await call<McpTestResult>('testMcpServer', { serverId: server.id })).ok).toBe(true)
    rejecting = true

    const tested = await call<McpTestResult>('testMcpServer', { serverId: server.id })
    expect(tested.error).toContain('invalid token ••••••')
    const draft = await call<McpTestResult>(
      'testMcpDraft',
      {},
      {
        serverId: server.id,
        config: { name: 'Echo', transport: 'http', url, headers: [{ name: 'Authorization', secret: true }] },
      },
    )
    expect(draft.error).toContain('invalid token ••••••')

    await call('postMessage', { conversationId: chiefDm }, { content: 'add 1 and 2' })
    await host.idle()
    const toolResult = requests[1]?.messages.at(-1)
    expect(toolResult).toMatchObject({ role: 'tool', toolName: 'mcp__echo__add', isError: true })
    expect(JSON.stringify(toolResult)).toContain('invalid token ••••••')

    const toolCalls = await call<ToolCallRow[]>('listToolCalls', { conversationId: chiefDm }, undefined, {
      limit: 20,
    })
    const llmCalls = await call<LlmCallRow[]>('listLlmCalls', { conversationId: chiefDm }, undefined, {
      limit: 20,
    })
    for (const leak of [tested, draft, requests, toolCalls, llmCalls])
      expect(JSON.stringify(leak)).not.toContain(token)
  })

  it('gives API-provider bots only their enabled tools, runs them and logs them redacted', async () => {
    await boot([
      { toolCalls: [{ name: 'mcp__test__add', arguments: { a: 40, b: 2 } }] },
      { toolCalls: [{ name: 'mcp__test__whoami', arguments: {} }] },
      { toolCalls: [{ name: 'mcp__test__echo', arguments: { text: 'switched off' } }] },
      { text: 'It is 42.' },
    ])
    const server = await call<McpServer>('createMcpServer', {}, stdioBody())
    await call('testMcpServer', { serverId: server.id })
    const prefs = await call<BotMcpServer[]>('listBotMcpServers', { botId: chiefId })
    expect(prefs).toEqual([{ serverId: server.id, enabled: true, disabledTools: [] }])
    await call('updateBotMcpServer', { botId: chiefId, serverId: server.id }, { disabledTools: ['echo'] })

    await call('postMessage', { conversationId: chiefDm }, { content: 'what is 40 + 2?' })
    await host.idle()

    const names = requests[0]?.tools.map((t) => t.name) ?? []
    expect(names).toContain('mcp__test__add')
    expect(names).toContain('mcp__test__whoami')
    expect(names).not.toContain('mcp__test__echo')
    const addResult = requests[1]?.messages.at(-1)
    expect(addResult).toMatchObject({
      role: 'tool',
      toolName: 'mcp__test__add',
      content: [{ type: 'text', text: '42' }],
    })
    const echoResult = requests[3]?.messages.at(-1)
    expect(echoResult).toMatchObject({ role: 'tool', isError: true })

    const toolCalls = await call<ToolCallRow[]>('listToolCalls', { conversationId: chiefDm }, undefined, {
      limit: 20,
    })
    expect(toolCalls.map((t) => [t.toolName, t.status])).toEqual([
      ['mcp__test__add', 'ok'],
      ['mcp__test__whoami', 'ok'],
      ['mcp__test__echo', 'error'],
    ])
    expect(JSON.stringify(toolCalls)).not.toContain(SECRET)
    expect(JSON.stringify(toolCalls[1]?.result)).toContain('token=••••••')

    const llmCalls = await call<LlmCallRow[]>('listLlmCalls', { conversationId: chiefDm }, undefined, {
      limit: 20,
    })
    expect(JSON.stringify(llmCalls)).not.toContain(SECRET)
    const composition = llmCalls.find((c) => c.purpose === 'turn')?.contextComposition
    expect(composition?.mcpServers?.Test).toBeGreaterThan(0)

    const page = await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
      limit: 20,
    })
    const activity = page.messages.find((m) => m.kind === 'activity')?.payload
    if (activity?.type !== 'activity') throw new Error('expected activity')
    expect(activity.steps.map((s) => [s.kind, s.detail])).toEqual([
      ['mcp', 'Test · add'],
      ['mcp', 'Test · whoami'],
      ['mcp', 'Test · echo'],
    ])
    const log = await call<Array<{ kind: string; detail: string }>>(
      'getBotActivity',
      { botId: chiefId },
      undefined,
      {
        limit: 5,
      },
    )
    expect(log[0]).toMatchObject({ kind: 'mcp' })
  })

  it('leaves servers out for bots that are not allowed or switched them off', async () => {
    await boot()
    const other = await call<{ bot: { id: string } }>('createBot', {}, { name: 'Iris', systemPrompt: 'x' })
    const server = await call<McpServer>('createMcpServer', {}, stdioBody({ allowedBots: [other.bot.id] }))
    await call('testMcpServer', { serverId: server.id })
    expect(await call<BotMcpServer[]>('listBotMcpServers', { botId: chiefId })).toEqual([])
    await expect(
      call('updateBotMcpServer', { botId: chiefId, serverId: server.id }, { enabled: false }),
    ).rejects.toThrow(/not allowed/)
    const chief = runtime.store.bots.get(chiefId)
    const irisBot = runtime.store.bots.get(other.bot.id)
    expect((await runtime.services.externalMcp.toolSet(chief)).tools).toEqual([])
    expect((await runtime.services.externalMcp.toolSet(irisBot)).tools).toHaveLength(3)
    await call('updateBotMcpServer', { botId: other.bot.id, serverId: server.id }, { enabled: false })
    expect((await runtime.services.externalMcp.toolSet(irisBot)).tools).toEqual([])
    const cc = await runtime.services.externalMcp.cliConfig(irisBot, 'claude_code')
    expect(cc.servers).toEqual({})
    await call(
      'updateBotMcpServer',
      { botId: other.bot.id, serverId: server.id },
      { enabled: true, disabledTools: ['whoami'] },
    )
    const enabled = await runtime.services.externalMcp.cliConfig(irisBot, 'claude_code')
    expect(enabled.servers.test).toMatchObject({
      type: 'stdio',
      command: process.execPath,
      env: { TEST_TOKEN: SECRET },
    })
    expect(enabled.disallowedTools).toEqual(['mcp__test__whoami'])
    // Disabling the server everywhere stops its connection.
    const off = await call<McpServer>('updateMcpServer', { serverId: server.id }, { enabled: false })
    expect(off.state.status).toBe('disabled')
    expect((await runtime.services.externalMcp.toolSet(irisBot)).tools).toEqual([])
  })
})

describe('external MCP servers without their secret', () => {
  it('still renames and switches a server whose Keychain entry is gone', async () => {
    await boot()
    const server = await call<McpServer>('createMcpServer', {}, stdioBody())
    await secrets.delete(h.workspaceId, `mcp.${server.id}.env.TEST_TOKEN`)
    const updated = await call<McpServer>(
      'updateMcpServer',
      { serverId: server.id },
      { name: 'Other', enabled: false },
    )
    expect(updated).toMatchObject({ name: 'Other', enabled: false })
  })
})
