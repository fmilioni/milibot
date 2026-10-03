import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import type { McpServer } from '@milibot/shared'
import { describe, expect, it, vi } from 'vitest'

import { McpAdmin, McpServerTools } from '../../../src/runtime/mcp'

const bot = makeBot({ id: 'bot_1', name: 'Ana' })
const other = makeBot({ id: 'bot_2', name: 'Iris', slug: 'iris' })
const ctx = {
  bot,
  conversationId: 'conv_1',
  turnId: null,
  signal: new AbortController().signal,
} as ToolExecContext

const text = (result: ToolResult) => result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

function setup(servers: McpServer[] = []) {
  const propose = vi.fn(async () => 'proposed')
  const tools = new McpServerTools({
    admin: { list: () => servers, propose, test: async () => 'tested', connect: async () => 'connected' },
    store: { validate: () => undefined },
    listBots: () => [bot, other],
    secretNames: () => ['API_KEY'],
    secretValues: () => ['s3cret-value-123', 'short'],
  })
  const run = (name: string, args: unknown) =>
    tools.execute(ctx, { id: 'c1', name, arguments: args as Record<string, unknown> })
  return { propose, run }
}

describe('McpServerTools', () => {
  it('refuses credentials passed as text and unknown secret references', async () => {
    const { run, propose } = setup()
    const add = (headers: unknown) => run('mcp_server_add', { name: 'X', url: 'https://x.dev/mcp', headers })
    expect(text(await add([{ name: 'X-Api-Key', value: 'abc' }]))).toMatch(/looks like a credential/)
    expect(text(await add({ 'X-Org': 'org s3cret-value-123' }))).toMatch(/looks like a credential/)
    expect(text(await add([{ name: 'X-Org', value: '{{secret:OTHER}}' }]))).toMatch(/OTHER.*not available/)
    expect(text(await add([{ name: 'X-Org', value: 'short' }]))).toBe('proposed')
    expect(propose).toHaveBeenCalledTimes(1)
  })

  it('proposes a server for the calling bot by default, with the card details', async () => {
    const { run, propose } = setup()
    await run('mcp_server_add', {
      name: 'Files',
      command: 'npx',
      args: ['-y', 'files-mcp'],
      env: [{ name: 'API_KEY', value: '{{secret:API_KEY}}' }],
    })
    expect(propose).toHaveBeenCalledWith(
      ctx,
      {
        kind: 'add',
        server: {
          name: 'Files',
          transport: 'stdio_vm',
          url: null,
          command: 'npx',
          args: ['-y', 'files-mcp'],
          headers: [],
          env: [{ name: 'API_KEY', value: '{{secret:API_KEY}}' }],
          allowedBots: ['bot_1'],
        },
      },
      {
        serverName: 'Files',
        details: {
          transport: 'stdio_vm',
          target: 'npx -y files-mcp',
          env: [{ name: 'API_KEY', value: '{{secret:API_KEY}}' }],
          bots: ['Ana'],
        },
        reason: '',
      },
    )
    await run('mcp_server_add', { name: 'Y', url: 'https://y.dev', bots: ['iris', 'Ana'] })
    expect(propose.mock.calls[1]?.[1]).toMatchObject({ server: { allowedBots: ['bot_2', 'bot_1'] } })
    const both = await run('mcp_server_add', { name: 'Z', url: 'https://z.dev', command: 'npx' })
    expect(text(both)).toMatch(/either "url".*or "command"/)
    const misplaced = await run('mcp_server_add', { name: 'Z', url: 'https://z.dev', env: { A: 'b' } })
    expect(text(misplaced)).toMatch(/remote server takes "headers"/)
  })

  it('names servers by name or slug and refuses a sign-in for a server in the VM', async () => {
    const server = { id: 'mcp_1', name: 'Files', slug: 'files', transport: 'stdio_vm' } as McpServer
    const { run } = setup([server])
    expect(text(await run('mcp_server_connect', { server: 'files' }))).toMatch(/only remote servers sign in/)
    expect(text(await run('mcp_server_test', { server: 'Files' }))).toBe('tested')
    expect(text(await run('mcp_server_test', { server: 'nope' }))).toMatch(/No MCP server named "nope"/)
    expect(text(await run('mcp_server_update', { server: 'files' }))).toMatch(/Nothing to change/)
  })
})

describe('McpAdmin', () => {
  it('expires the sign-in cards a previous runtime left pending', () => {
    const updateMessage = vi.fn()
    const admin = new McpAdmin({
      mcp: {} as never,
      confirmations: { request: vi.fn(), onConfirmed: vi.fn(), onRejected: vi.fn() },
      host: { enqueueTurn: vi.fn() },
      findBot: () => bot,
      listBots: () => [bot],
      cardConversation: () => 'conv_1',
      resolveSecretRefs: (_bot, value) => value,
      appendMessage: vi.fn(),
      updateMessage,
      pendingSignInCards: () => [
        {
          id: 'msg_1',
          payload: {
            type: 'mcp_sign_in',
            serverId: 'mcp_1',
            serverName: 'Notion',
            botId: 'bot_1',
            authorizationUrl: 'https://auth.dev',
            status: 'pending',
          },
        },
      ],
      timeoutSeconds: () => 60,
      log: () => undefined,
    })
    admin.start()
    expect(updateMessage).toHaveBeenCalledWith('msg_1', {
      payload: expect.objectContaining({ status: 'expired' }) as unknown,
      content: 'Sign-in to the MCP server Notion: expired',
    })
  })
})
