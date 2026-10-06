import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import type { BotMcpServer, ConfirmationPayload, McpServer, Message } from '@milibot/shared'
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

function setup(servers: McpServer[] = [], options: { manager?: boolean; prefs?: BotMcpServer[] } = {}) {
  const propose = vi.fn(async (..._args: unknown[]) => 'proposed')
  const proposeBot = vi.fn(async (..._args: unknown[]) => 'proposed for a bot')
  const tools = new McpServerTools({
    admin: {
      list: () => servers,
      propose,
      proposeBot,
      test: async () => 'tested',
      connect: async () => 'connected',
    },
    store: { validate: () => undefined },
    listBots: () => [bot, other],
    botServers: () => options.prefs ?? [],
    managesTeam: () => options.manager ?? true,
    secretNames: () => ['API_KEY'],
    secretValues: () => ['s3cret-value-123', 'short'],
  })
  const run = (name: string, args: unknown) =>
    tools.execute(ctx, { id: 'c1', name, arguments: args as Record<string, unknown> })
  return { propose, proposeBot, run }
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

  it('refuses credentials written as text in the url, command and args, even when not saved', async () => {
    const { run, propose } = setup()
    const literal = 'Zx9-literal-not-saved'
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ url: `https://x.dev/mcp?api_key=${literal}` }, /query parameter "api_key"/],
      [{ url: `https://x.dev/mcp?org=a&token=${literal}` }, /query parameter "token"/],
      [{ url: `https://x.dev/mcp?access_token=${literal}` }, /query parameter "access_token"/],
      [{ url: `https://x.dev/mcp?key=${literal}` }, /query parameter "key"/],
      [{ url: `https://x.dev/mcp?client_secret=${literal}` }, /query parameter "client_secret"/],
      [{ url: `https://x.dev/mcp?password=${literal}` }, /query parameter "password"/],
      [{ url: `https://x.dev/mcp#access_token=${literal}` }, /query parameter "access_token"/],
      [{ url: `https://ana:${literal}@x.dev/mcp` }, /user and password/],
      [{ url: `https://${literal}@x.dev/mcp` }, /user and password/],
      [{ url: 'https://x.dev/mcp/ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, /API key or token/],
      [{ command: 'npx', args: ['-y', 'srv', `--token=${literal}`] }, /flag "--token"/],
      [{ command: 'npx', args: ['-y', 'srv', '--token', literal] }, /flag "--token"/],
      [{ command: 'npx', args: ['srv', '--api-key', literal] }, /flag "--api-key"/],
      [{ command: 'npx', args: ['srv', '--password', literal] }, /flag "--password"/],
      [{ command: 'npx', args: ['srv', `-access_token=${literal}`] }, /flag "--access_token"/],
      [{ command: 'npx', args: ['srv', `API_KEY=${literal}`] }, /"API_KEY"/],
      [{ command: 'npx', args: ['srv', `GITHUB_TOKEN=${literal}`] }, /"GITHUB_TOKEN"/],
      [{ command: 'npx', args: ['mcp-remote', `https://x.dev/sse?apikey=${literal}`] }, /"apikey"/],
      [
        { command: 'npx', args: ['mcp-remote', '--header', `Authorization: Bearer ${literal}`] },
        /"Authorization"/,
      ],
      [{ command: 'npx', args: ['srv', 'sk-proj-abcdefghijklmnopqrstuvwxyz'] }, /API key or token/],
      [{ command: `srv --token ${literal}` }, /"command" looks like.*flag "--token"/],
    ]
    for (const [args, reason] of refused) {
      const result = text(await run('mcp_server_add', { name: 'D', ...args }))
      expect(result, JSON.stringify(args)).toMatch(/"(url|command|args)" looks like it carries a credential/)
      expect(result, JSON.stringify(args)).toMatch(reason)
      expect(result).toMatch(/request_secret.*\{\{secret:NAME\}\}/)
      expect(result).not.toContain(literal)
    }
    const server = { id: 'mcp_1', name: 'Files', slug: 'files', transport: 'stdio_vm', args: [] }
    const update = setup([server as unknown as McpServer])
    const changed = await update.run('mcp_server_update', { server: 'files', args: ['--api-key', literal] })
    expect(text(changed)).toMatch(/"args" looks like.*flag "--api-key"/)
    expect(propose).not.toHaveBeenCalled()
    expect(update.propose).not.toHaveBeenCalled()
  })

  it('checks the value of a --flag=value for the credential it carries', async () => {
    const { run, propose } = setup()
    const literal = 'Zx9-literal-not-saved'
    const refused: [Record<string, unknown>, RegExp][] = [
      [
        { command: 'npx', args: ['mcp-remote', `--header=Authorization: Bearer ${literal}`] },
        /"Authorization"/,
      ],
      [
        { command: 'npx', args: ['mcp-remote', `--header="Authorization: Bearer ${literal}"`] },
        /"Authorization"/,
      ],
      [{ command: 'npx', args: ['srv', `--url=https://ana:${literal}@x.dev/mcp`] }, /user and password/],
      [{ command: 'npx', args: ['srv', `--url=https://x.dev/mcp?api_key=${literal}`] }, /"api_key"/],
      [{ command: 'npx', args: ['srv', `--env=API_KEY=${literal}`] }, /"API_KEY"/],
      [
        { command: 'npx', args: ['srv', `-e=DATABASE_URL=postgresql://u:${literal}@db/app`] },
        /user and password/,
      ],
      [{ command: `npx mcp-remote --header=Authorization: Bearer ${literal}` }, /"Authorization"/],
      [{ command: `npx mcp-remote --header Authorization: Bearer ${literal}` }, /"Authorization"/],
    ]
    for (const [args, reason] of refused) {
      const result = text(await run('mcp_server_add', { name: 'D', ...args }))
      expect(result, JSON.stringify(args)).toMatch(/"(command|args)" looks like it carries a credential/)
      expect(result, JSON.stringify(args)).toMatch(reason)
      expect(result).toMatch(/request_secret.*\{\{secret:NAME\}\}/)
      expect(result).not.toContain(literal)
    }
    expect(propose).not.toHaveBeenCalled()
  })

  it('recognizes a credential by its value in env and headers, whatever their name', async () => {
    const { run, propose } = setup()
    const literal = 'Zx9-literal-not-saved'
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl'
    const ghp = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const stdio = (env: Record<string, string>) => ({ name: 'D', command: 'npx', args: ['srv'], env })
    const http = (headers: Record<string, string>) => ({ name: 'D', url: 'https://x.dev/mcp', headers })
    const refused: [Record<string, unknown>, RegExp][] = [
      [stdio({ DATABASE_URL: `postgresql://app:${literal}@db:5432/app` }), /DATABASE_URL.*user and password/],
      [stdio({ CACHE: `redis://:${literal}@cache:6379` }), /CACHE.*user and password/],
      [stdio({ GH: ghp }), /GH.*API key or token/],
      [stdio({ CONFIG: jwt }), /CONFIG.*API key or token/],
      [stdio({ OPTIONS: `--verbose --api-key ${literal}` }), /OPTIONS.*flag "--api-key"/],
      [stdio({ UPSTREAM: `https://x.dev/sse?token=${literal}` }), /UPSTREAM.*"token"/],
      [http({ 'X-Upstream': `https://ana:${literal}@x.dev` }), /X-Upstream.*user and password/],
      [http({ 'X-Custom': ghp }), /X-Custom.*API key or token/],
      [http({ 'X-Custom': `Bearer ${jwt}` }), /X-Custom.*API key or token/],
      [http({ 'X-Org': `{{secret:API_KEY}} ${ghp}` }), /X-Org.*API key or token/],
    ]
    for (const [args, reason] of refused) {
      const result = text(await run('mcp_server_add', args))
      expect(result, JSON.stringify(args)).toMatch(/looks like a credential/)
      expect(result, JSON.stringify(args)).toMatch(reason)
      expect(result).toMatch(/request_secret.*\{\{secret:NAME\}\}/)
      for (const value of [literal, jwt, ghp]) expect(result).not.toContain(value)
    }
    expect(propose).not.toHaveBeenCalled()
    const accepted = [
      stdio({ DATABASE_URL: 'postgresql://app:{{secret:API_KEY}}@db:5432/app' }),
      stdio({
        DATABASE_URL: 'postgresql://db:5432/app',
        MAX_TOKENS: '4096',
        NODE_OPTIONS: '--max-old-space-size=4096',
      }),
      stdio({
        GOOGLE_APPLICATION_CREDENTIALS: '/workspace/keys/sa.json',
        GITHUB_TOKEN: '{{secret:API_KEY}}',
      }),
      http({ 'X-Keyword': 'mcp', 'X-Author': 'ana', Authorization: 'Bearer {{secret:API_KEY}}' }),
    ]
    for (const args of accepted)
      expect(text(await run('mcp_server_add', args)), JSON.stringify(args)).toBe('proposed')
  })

  it('does not take a name as a credential for a credential word inside another word', async () => {
    const { run, propose } = setup()
    const accepted: Record<string, unknown>[] = [
      { command: 'npx', args: ['srv', '--max-tokens', '4096', '--max-tokens=8192'] },
      { command: 'npx', args: ['srv', '--keyword', 'invoices', '--keyword=reports'] },
      { command: 'npx', args: ['srv', '--author', 'ana', '--author=ana'] },
      { command: 'npx', args: ['srv', '--keyspace', 'prod', '--keyspace=prod'] },
      { command: 'npx', args: ['srv', '--token-limit', '4096', 'MAX_TOKENS=4096', 'AUTHOR=ana'] },
      { command: 'srv --max-tokens 4096 --keyword invoices --author ana --keyspace prod' },
      { url: 'https://x.dev/mcp?keyword=a&author=b&keyspace=c&max_tokens=4096' },
    ]
    for (const args of accepted)
      expect(text(await run('mcp_server_add', { name: 'D', ...args })), JSON.stringify(args)).toBe('proposed')
    expect(propose).toHaveBeenCalledTimes(accepted.length)
  })

  it('accepts url, command and args that only name or point to a credential', async () => {
    const { run, propose } = setup()
    const accepted: Record<string, unknown>[] = [
      { url: 'https://x.dev/mcp' },
      { url: 'https://x.dev/mcp?org=acme&region=us&keyboard=true' },
      { url: 'https://x.dev/mcp?auth=oauth&session=true' },
      { url: 'https://x.dev/auth/token/mcp' },
      { command: 'npx', args: ['-y', '@acme/key-value-mcp', '--port', '3000'] },
      { command: 'npx', args: ['srv', '--token-file', '/run/secrets/token'] },
      { command: 'npx', args: ['srv', '--api-key-env', 'API_KEY', '--auth-type', 'bearer'] },
      { command: 'npx', args: ['srv', '--key', './certs/client.key', '--no-auth'] },
      { command: 'npx', args: ['srv', '--token', '$GITHUB_TOKEN', '--auth', '--verbose'] },
      {
        command: 'npx',
        args: ['mcp-remote', 'https://x.dev/sse', '--header', 'Authorization:${AUTH_HEADER}'],
      },
      { command: 'npx', args: ['srv', 'MODE=production', 'API_KEY=${API_KEY}'] },
    ]
    for (const args of accepted)
      expect(text(await run('mcp_server_add', { name: 'D', ...args })), JSON.stringify(args)).toBe('proposed')
    expect(propose).toHaveBeenCalledTimes(accepted.length)
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

describe('bot_mcp_set', () => {
  const notion = { id: 'mcp_1', name: 'Notion', slug: 'notion', allowedBots: ['bot_2'], tools: [] }
  const linear = { id: 'mcp_2', name: 'Linear', slug: 'linear', allowedBots: 'all', tools: [] }
  const servers = [notion, linear] as unknown as McpServer[]

  it('is only for bots that manage the team, even on themselves', async () => {
    const { run, proposeBot } = setup(servers, { manager: false })
    expect(text(await run('bot_mcp_set', { enable: ['linear'] }))).toMatch(/manages the team/)
    expect(proposeBot).not.toHaveBeenCalled()
  })

  it('asks for every change, marks access the approval grants and skips what is already so', async () => {
    const prefs = [{ serverId: 'mcp_2', enabled: false, disabledTools: [] }]
    const { run, proposeBot } = setup(servers, { prefs })
    expect(text(await run('bot_mcp_set', { enable: ['notion', 'linear'] }))).toBe('proposed for a bot')
    expect(proposeBot).toHaveBeenCalledWith(
      ctx,
      bot,
      [
        { server: notion, on: true, allow: true },
        { server: linear, on: true, allow: false },
      ],
      '',
    )
    expect(text(await run('bot_mcp_set', { bot: 'iris', disable: ['notion'] }))).toBe('proposed for a bot')
    expect(proposeBot.mock.calls[1]?.[1]).toBe(other)
    expect(text(await run('bot_mcp_set', { disable: ['linear', 'notion'] }))).toMatch(/Nothing to change/)
    expect(text(await run('bot_mcp_set', {}))).toMatch(/"enable"/)
    expect(proposeBot).toHaveBeenCalledTimes(2)
  })
})

describe('McpAdmin', () => {
  it('applies a bot change only on approval, giving access first', async () => {
    const handlers = new Map<string, ConfirmationHandler>()
    const server = { id: 'mcp_1', name: 'Notion', enabled: true, allowedBots: ['bot_1'], tools: [] }
    const updateServer = vi.fn(async (_id: string, body: { allowedBots: string[] }) => ({
      ...server,
      ...body,
    }))
    const setBotServer = vi.fn()
    let manager = true
    const admin = new McpAdmin({
      mcp: {
        listServers: () => [server],
        getServer: () => server,
        updateServer,
        setBotServer,
      } as never,
      confirmations: {
        request: () =>
          ({ payload: { type: 'confirmation', confirmationId: 'cnf_1' } as ConfirmationPayload }) as Message,
        onConfirmed: (action, handler) => handlers.set(action, handler),
        onRejected: vi.fn(),
      },
      host: { enqueueTurn: vi.fn() },
      findBot: (id) => [bot, other].find((b) => b.id === id) ?? null,
      listBots: () => [bot, other],
      managesTeam: () => manager,
      cardConversation: () => 'conv_1',
      resolveSecretRefs: (_bot, value) => value,
      appendMessage: vi.fn(),
      updateMessage: vi.fn(),
      pendingSignInCards: () => [],
      timeoutSeconds: () => 600,
      log: () => undefined,
    })
    const waiting = admin.proposeBot(ctx, other, [{ server: server as unknown as McpServer, on: true, allow: true }], '')
    expect(updateServer).not.toHaveBeenCalled()
    expect(setBotServer).not.toHaveBeenCalled()
    const input = {
      confirmationId: 'cnf_1',
      requesterId: bot.id,
      conversationId: 'conv_1',
      params: { botId: other.id, botName: other.name },
      data: {
        proposal: { kind: 'bot', botId: other.id, changes: [{ serverId: 'mcp_1', on: true, allow: true }] },
      },
    }
    handlers.get('bot_mcp')?.(input)
    await expect(waiting).resolves.toMatch(/MCP servers of Iris: Notion on/)
    expect(updateServer).toHaveBeenCalledWith('mcp_1', { allowedBots: ['bot_1', 'bot_2'] })
    expect(setBotServer).toHaveBeenCalledWith('bot_2', 'mcp_1', { enabled: true })

    manager = false
    expect(() => handlers.get('bot_mcp')?.(input)).toThrow(DaemonError)
    expect(setBotServer).toHaveBeenCalledTimes(1)
  })

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
      managesTeam: () => true,
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
      managesTeam: () => true,
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
