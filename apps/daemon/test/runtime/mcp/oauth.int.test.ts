import type { DefaultAgentHost } from '@milibot/agent'
import type { McpOAuthStart, McpServer, McpTestResult, ToolCallRow } from '@milibot/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { MemorySecretStore } from '../../../src/secrets/secret-store'
import { startOAuthMcpServer } from '../../fixtures/mcp-oauth-server.mjs'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

type OAuthServer = Awaited<ReturnType<typeof startOAuthMcpServer>>
type Step = { text?: string; toolCalls?: Array<{ name: string; arguments?: unknown }> }

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let secrets: MemorySecretStore
let remote: OAuthServer
let chiefId: string
let chiefDm: string

const dir = useTempDir('oauth')
beforeEach(async () => {
  remote = await startOAuthMcpServer()
})
afterEach(async () => {
  await stopRuntimes()
  await remote?.close()
})

async function boot(script: Step[] = []) {
  let turn = 0
  h = await bootRuntime({
    dir: dir(),
    host: { compaction: false },
    script: (request) => {
      if (request.tools.length === 0) return { text: 'Hi!' }
      return script[turn++] ?? { text: 'Done.' }
    },
  })
  ;({ runtime, host, secrets, botId: chiefId, dm: chiefDm } = h)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

const server = async (id: string) =>
  (await call<McpServer[]>('listMcpServers')).find((s) => s.id === id) as McpServer

/** Plays the browser: follows the authorization URL to the loopback redirect and loads it. */
async function approveInBrowser(authorizationUrl: string, language: string): Promise<Response> {
  const authorize = await fetch(authorizationUrl, { redirect: 'manual' })
  expect(authorize.status).toBe(302)
  const callback = authorize.headers.get('location') as string
  expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?code=/)
  return fetch(callback, { headers: { 'accept-language': language } })
}

/** The loopback page answers in the browser's language. */
async function signIn(serverId: string, language: 'en' | 'pt-BR' = 'en'): Promise<void> {
  const started = await call<McpOAuthStart>('startMcpOAuth', { serverId })
  expect(started.authorizationUrl).toBeTruthy()
  expect(started.server.oauth).toMatchObject({ authorizing: true, connected: false })
  const page = await approveInBrowser(started.authorizationUrl as string, language)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain(language === 'en' ? 'Milibot connected' : 'Milibot conectado')
  await until(async () => (await server(serverId)).state.status === 'connected', 8000)
}

describe('OAuth remote MCP servers', () => {
  it('detects OAuth, signs in through the browser and the loopback, stores tokens and refreshes them', async () => {
    await boot()
    const draft = await call<McpTestResult>(
      'testMcpDraft',
      {},
      { config: { name: 'Notion', transport: 'http', url: remote.url } },
    )
    expect(draft).toMatchObject({ ok: false, authRequired: true })

    const created = await call<McpServer>(
      'createMcpServer',
      {},
      { name: 'Notion', transport: 'http', url: remote.url },
    )
    const tested = await call<McpTestResult>('testMcpServer', { serverId: created.id })
    expect(tested.authRequired).toBe(true)
    expect(await server(created.id)).toMatchObject({
      state: { status: 'needs_auth' },
      oauth: { connected: false, account: null, authorizing: false },
    })

    await signIn(created.id)
    const connected = await server(created.id)
    expect(connected.oauth).toMatchObject({ connected: true, account: 'ana@example.com', authorizing: false })
    await until(async () => (await server(created.id)).tools.length === 3, 8000)
    expect(remote.stats).toMatchObject({ registrations: 1, authorizations: 1, exchanges: 1 })

    // Tokens live in the secret store, never in the database or the API.
    const stored = JSON.parse((await secrets.get(h.workspaceId, `mcp.${created.id}.oauth`)) as string) as {
      tokens: { access_token: string; refresh_token: string }
      clientInformation: { client_id: string }
    }
    expect(stored.tokens.access_token).toMatch(/^at_/)
    expect(stored.clientInformation.client_id).toMatch(/^client_/)
    expect(JSON.stringify(await call('listMcpServers'))).not.toContain(stored.tokens.access_token)
    const settings = runtime.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'mcp.oauth.%'").all()
    expect(JSON.stringify(settings)).not.toContain(stored.tokens.access_token)

    // An API-provider bot calls the tool with the signed-in client.
    const manager = runtime.services.externalMcp.manager
    expect(await manager.callTool(created.id, 'echo', { text: 'hi' })).toMatchObject({
      content: [{ type: 'text', text: 'hi' }],
    })

    // An expired access token is refreshed without the user.
    remote.expireAccessTokens()
    await manager.reset(created.id)
    expect(await manager.callTool(created.id, 'echo', { text: 'again' })).toMatchObject({
      content: [{ type: 'text', text: 'again' }],
    })
    expect(remote.stats.refreshes).toBe(1)
    expect((await server(created.id)).oauth?.connected).toBe(true)

    // "Reconnect" with a sign-in that can still be refreshed doesn't need the browser.
    const again = await call<McpOAuthStart>('startMcpOAuth', { serverId: created.id })
    expect(again.authorizationUrl).toBeNull()
    expect(again.server.oauth).toMatchObject({ connected: true, authorizing: false })

    // After "Disconnect" the browser flow reuses the registered client and its loopback port.
    await call('disconnectMcpOAuth', { serverId: created.id })
    await signIn(created.id)
    expect(remote.stats).toMatchObject({ registrations: 1, authorizations: 2 })
    expect(new Set(remote.stats.redirectUris).size).toBe(1)
  })

  it('asks to reconnect when the refresh token is refused, and forgets the tokens on "Disconnect"', async () => {
    await boot()
    const created = await call<McpServer>(
      'createMcpServer',
      {},
      { name: 'Linear', transport: 'http', url: remote.url },
    )
    await call('testMcpServer', { serverId: created.id })
    await signIn(created.id)

    remote.revokeRefreshTokens()
    remote.expireAccessTokens()
    const manager = runtime.services.externalMcp.manager
    await manager.reset(created.id)
    await expect(manager.callTool(created.id, 'echo', { text: 'x' })).rejects.toThrow()
    await until(async () => (await server(created.id)).state.status === 'needs_auth', 8000)
    expect((await server(created.id)).oauth?.connected).toBe(false)

    await signIn(created.id, 'pt-BR')
    expect((await server(created.id)).oauth?.connected).toBe(true)

    const disconnected = await call<McpServer>('disconnectMcpOAuth', { serverId: created.id })
    expect(disconnected).toMatchObject({
      state: { status: 'needs_auth' },
      oauth: { connected: false, account: null },
    })
    const record = JSON.parse((await secrets.get(h.workspaceId, `mcp.${created.id}.oauth`)) as string) as {
      tokens?: unknown
    }
    expect(record.tokens).toBeUndefined()

    const started = await call<McpOAuthStart>('startMcpOAuth', { serverId: created.id })
    expect((await call<McpServer>('cancelMcpOAuth', { serverId: created.id })).oauth?.authorizing).toBe(false)
    const late = await fetch(
      (await fetch(started.authorizationUrl as string, { redirect: 'manual' })).headers.get(
        'location',
      ) as string,
    ).catch(() => null)
    expect(late === null || late.status !== 200).toBe(true)

    await call('deleteMcpServer', { serverId: created.id })
    expect(await secrets.get(h.workspaceId, `mcp.${created.id}.oauth`)).toBeNull()
  })

  it('serves an OAuth server to Claude Code through the daemon proxy, never with its URL or tokens', async () => {
    await boot([
      { toolCalls: [{ name: 'mcp__notion__echo', arguments: { text: 'from a turn' } }] },
      { text: 'done' },
    ])
    const created = await call<McpServer>(
      'createMcpServer',
      {},
      { name: 'Notion', transport: 'http', url: remote.url },
    )
    await call('testMcpServer', { serverId: created.id })
    await signIn(created.id)
    await until(async () => (await server(created.id)).tools.length === 3, 8000)
    await call('updateBotMcpServer', { botId: chiefId, serverId: created.id }, { disabledTools: ['add'] })

    const mcp = runtime.services.mcp
    const bot = runtime.store.bots.list().find((b) => b.id === chiefId)
    if (!bot) throw new Error('no chief')
    const endpoint = await mcp.proxyEndpointFor(bot.id, 'claude_code')
    const config = await runtime.services.externalMcp.cliConfig(bot, 'claude_code', endpoint)
    expect(config.servers.notion).toEqual({
      type: 'http',
      url: expect.stringMatching(/^http:\/\/10\.0\.2\.2:\d+\/mcp\/x\/notion$/),
      headers: { Authorization: `Bearer ${endpoint.token}` },
    })
    expect(JSON.stringify(config.servers)).not.toContain(remote.url)
    expect(config.disallowedTools).toEqual(['mcp__notion__add'])
    expect(
      (
        await runtime.services.externalMcp.cliConfig(
          bot,
          'claude_code',
          await mcp.proxyEndpointFor(bot.id, 'claude_code'),
        )
      ).fingerprint,
    ).toBe(config.fingerprint)

    // What Claude Code does from the VM (here from the host): a plain MCP client on the proxy.
    const client = new Client({ name: 'claude-code', version: 'test' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${mcp.localUrl}/x/notion`), {
        requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
      }),
    )
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['echo', 'whoami'])
    expect(await client.callTool({ name: 'echo', arguments: { text: 'proxied' } })).toMatchObject({
      content: [{ type: 'text', text: 'proxied' }],
    })
    expect(await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } })).toMatchObject({ isError: true })
    await client.close()

    const denied = await fetch(`${mcp.localUrl}/x/notion`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    })
    expect(denied.status).toBe(401)

    // API-provider bots use the same signed-in client directly.
    await call('postMessage', { conversationId: chiefDm }, { content: 'echo' })
    await host.idle()
    const toolCalls = await call<ToolCallRow[]>('listToolCalls', { conversationId: chiefDm })
    expect(toolCalls.find((t) => t.toolName === 'mcp__notion__echo')).toMatchObject({ status: 'ok' })
  })
})
