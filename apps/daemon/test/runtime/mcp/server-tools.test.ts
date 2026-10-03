import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import type { ConfirmationPayload, McpServer, Message } from '@milibot/shared'
import { describe, expect, it, vi } from 'vitest'

import { DaemonError } from '../../../src/errors'
import type { ConfirmationHandler } from '../../../src/runtime/groups'
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
  const propose = vi.fn(async (..._args: unknown[]) => 'proposed')
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

  it('refuses secrets in the url, command and args, which are stored as they are', async () => {
    const { run, propose } = setup()
    const refused = [
      { name: 'D', url: 'https://x.dev/mcp?api_key=s3cret-value-123' },
      { name: 'D', url: 'https://x.dev/mcp?api_key={{secret:API_KEY}}' },
      { name: 'E', command: 'node', args: ['--key=s3cret-value-123'] },
      { name: 'E', command: 'node', args: ['--key={{secret:API_KEY}}'] },
      { name: 'E', command: 'run-s3cret-value-123' },
    ]
    for (const args of refused) {
      expect(text(await run('mcp_server_add', args))).toMatch(/"(url|command|args)" (cannot take|looks like)/)
    }
    const server = {
      id: 'mcp_1',
      name: 'Files',
      slug: 'files',
      transport: 'http',
      args: [],
    } as unknown as McpServer
    const update = setup([server])
    expect(
      text(
        await update.run('mcp_server_update', { server: 'files', url: 'https://x.dev/?k=s3cret-value-123' }),
      ),
    ).toMatch(/"url" looks like/)
    expect(text(await run('mcp_server_add', { name: 'F', url: 'https://x.dev/mcp?org=short' }))).toBe(
      'proposed',
    )
    expect(propose).toHaveBeenCalledTimes(1)
    expect(update.propose).not.toHaveBeenCalled()
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
    const server = {
      id: 'mcp_1',
      name: 'Files',
      slug: 'files',
      transport: 'stdio_vm',
      allowedBots: 'all',
    } as McpServer
    const { run } = setup([server])
    expect(text(await run('mcp_server_connect', { server: 'files' }))).toMatch(/only remote servers sign in/)
    expect(text(await run('mcp_server_test', { server: 'Files' }))).toBe('tested')
    expect(text(await run('mcp_server_test', { server: 'nope' }))).toMatch(/No MCP server named "nope"/)
    expect(text(await run('mcp_server_update', { server: 'files' }))).toMatch(/Nothing to change/)
  })

  it('tests and signs in only for the bots allowed on the server', async () => {
    const server = { id: 'mcp_1', name: 'Notion', slug: 'notion', transport: 'http', allowedBots: ['bot_2'] }
    const { run } = setup([server as McpServer])
    expect(text(await run('mcp_server_test', { server: 'notion' }))).toMatch(/Notion is not enabled for you/)
    expect(text(await run('mcp_server_connect', { server: 'notion' }))).toMatch(
      /Notion is not enabled for you/,
    )
  })
})

describe('McpAdmin', () => {
  it('tells the waiting bot when the server of an approved change was deleted meanwhile', async () => {
    const handlers = new Map<string, ConfirmationHandler>()
    const enqueueTurn = vi.fn()
    const admin = new McpAdmin({
      mcp: {
        getServer: () => {
          throw new DaemonError('not_found', 'MCP server not found')
        },
      } as never,
      confirmations: {
        request: () =>
          ({ payload: { type: 'confirmation', confirmationId: 'cnf_1' } as ConfirmationPayload }) as Message,
        onConfirmed: (action, handler) => handlers.set(action, handler),
        onRejected: vi.fn(),
      },
      host: { enqueueTurn },
      findBot: () => bot,
      listBots: () => [bot],
      cardConversation: () => 'conv_1',
      resolveSecretRefs: (_bot, value) => value,
      appendMessage: vi.fn(),
      updateMessage: vi.fn(),
      pendingSignInCards: () => [],
      timeoutSeconds: () => 600,
      log: () => undefined,
    })
    const waiting = admin.propose(
      ctx,
      { kind: 'remove', serverId: 'mcp_1' },
      { serverName: 'Notion', details: {}, reason: '' },
    )
    const input = {
      confirmationId: 'cnf_1',
      requesterId: bot.id,
      conversationId: 'conv_1',
      params: { botId: bot.id, botName: bot.name, serverName: 'Notion' },
      data: { proposal: { kind: 'remove', serverId: 'mcp_1' } },
    }
    expect(() => handlers.get('mcp_remove')?.(input)).toThrow(DaemonError)
    await expect(waiting).resolves.toMatch(/Notion no longer exists.*Nothing changed/)

    expect(() => handlers.get('mcp_remove')?.(input)).toThrow(DaemonError)
    expect(enqueueTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: bot.id,
        trigger: 'user_answer',
        note: expect.stringMatching(/no longer exists/),
      }),
    )
  })

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
