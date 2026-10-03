import { createServer, type Server } from 'node:http'

import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import { type McpServer, type Message, USER_REQUEST_TIMEOUT_KEY } from '@milibot/shared'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'

import type { MemorySecretStore } from '../../../src/secrets/secret-store'
import { startOAuthMcpServer } from '../../fixtures/mcp-oauth-server.mjs'
import { buildServer } from '../../fixtures/mcp-test-server.mjs'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

const TOKEN = 'mcp_token_value_8f2e1c'

type Step = { text?: string; toolCalls?: Array<{ name: string; arguments?: unknown }> }

let h: RuntimeHarness
let host: DefaultAgentHost
let secrets: MemorySecretStore
let chiefId: string
let chiefDm: string
let requests: CompletionRequest[]
let http: Server | null = null
let oauth: Awaited<ReturnType<typeof startOAuthMcpServer>> | null = null

const dir = useTempDir('mcp-admin')
afterEach(async () => {
  await stopRuntimes()
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
  http = null
  await oauth?.close()
  oauth = null
})

async function boot(script: Step[]) {
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
  ;({ host, secrets, botId: chiefId, dm: chiefDm } = h)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function startHttp(token: string): Promise<string> {
  http = createServer((req, res) => {
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

async function messages(): Promise<Message[]> {
  const page = await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
    limit: 100,
  })
  return page.messages
}

/** The newest card of `type` matching `where`, once it shows up. */
async function card(type: string, where: (payload: Record<string, unknown>) => boolean = () => true) {
  let found: Message | undefined
  await until(async () => {
    found = (await messages())
      .filter((m) => m.payload?.type === type && where(m.payload as Record<string, unknown>))
      .at(-1)
    return found !== undefined
  }, 8000)
  return found as Message & { payload: Record<string, unknown> }
}

const pendingConfirmation = (action: string) =>
  card('confirmation', (p) => p.action === action && p.status === 'pending')

async function resolve(confirmation: Message, approved: boolean): Promise<Message> {
  return call<Message>(
    'resolveConfirmation',
    { confirmationId: (confirmation.payload as { confirmationId: string }).confirmationId },
    { approved },
  )
}

/** Text results the bot got back, in order. */
function toolResults(): string[] {
  return requests
    .map((r) => r.messages.at(-1))
    .filter((m) => m?.role === 'tool')
    .map((m) => JSON.stringify(m?.content))
}

const servers = () => call<McpServer[]>('listMcpServers')

describe('bots managing MCP servers', () => {
  it('adds a server with a secret header after the confirmation, tests it and removes it', async () => {
    const url = await startHttp(TOKEN)
    await boot([
      {
        toolCalls: [
          {
            name: 'mcp_server_add',
            arguments: {
              name: 'Tracker',
              url: 'http://127.0.0.1:1/mcp',
              headers: [{ name: 'Authorization', value: 'Bearer plain-text-value' }],
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'mcp_server_add',
            arguments: {
              name: 'Tracker',
              url,
              headers: [{ name: 'Authorization', value: 'Bearer {{secret:UNKNOWN}}' }],
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'mcp_server_add',
            arguments: {
              name: 'Tracker',
              url,
              headers: [{ name: 'Authorization', value: 'Bearer {{secret:TRACKER_TOKEN}}' }],
              reason: 'To read the issues',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'mcp_server_list', arguments: {} }] },
      { toolCalls: [{ name: 'mcp_server_test', arguments: { server: 'tracker' } }] },
      { toolCalls: [{ name: 'mcp_server_remove', arguments: { server: 'Tracker' } }] },
      { text: 'Done.' },
    ])
    await call(
      'createEnvSecret',
      {},
      { name: 'TRACKER_TOKEN', value: TOKEN, scope: 'all', exposeAsEnv: false },
    )

    await call('postMessage', { conversationId: chiefDm }, { content: 'connect the tracker MCP' })
    const confirmation = await pendingConfirmation('mcp_add')
    expect(confirmation.content).toContain('wants to add the MCP server Tracker')
    const params = confirmation.payload.params as Record<string, string>
    expect(params.serverName).toBe('Tracker')
    expect(JSON.parse(params.details as string)).toEqual({
      transport: 'http',
      target: url,
      headers: [{ name: 'Authorization', value: 'Bearer {{secret:TRACKER_TOKEN}}' }],
      bots: [h.store.bots.get(chiefId).name],
    })
    await resolve(confirmation, true)
    // The removal waits for its own confirmation, so the turn is still going.
    const removal = await pendingConfirmation('mcp_remove')
    expect(await servers()).toHaveLength(1)

    const results = toolResults()
    expect(results[0]).toMatch(/Authorization looks like a credential/)
    expect(results[1]).toMatch(/UNKNOWN.*not available to you.*request_secret/)
    expect(results[2]).toMatch(/Added the MCP server Tracker\. Test passed: 3 tools/)
    expect(results[3]).toMatch(/- Tracker \(mcp_\w+, slug tracker\): remote/)
    expect(results[3]).toContain('headers: Authorization (secret)')
    expect(results[4]).toMatch(/Test passed: 3 tools/)

    await resolve(removal, true)
    await host.idle()
    expect(toolResults()[5]).toContain('Removed the MCP server Tracker')
    expect(await servers()).toEqual([])
    expect(JSON.stringify(requests)).not.toContain(TOKEN)
    expect(JSON.stringify(await messages())).not.toContain(TOKEN)
  })

  it('signs in to an OAuth server from a card in the chat and tells the bot it connected', async () => {
    oauth = await startOAuthMcpServer()
    await boot([
      {
        toolCalls: [{ name: 'mcp_server_add', arguments: { name: 'Notion', url: oauth.url, bots: ['all'] } }],
      },
    ])
    await call('postMessage', { conversationId: chiefDm }, { content: 'connect Notion' })
    const confirmation = await pendingConfirmation('mcp_add')
    expect(
      JSON.parse((confirmation.payload.params as Record<string, string>).details as string),
    ).toMatchObject({
      bots: 'all',
    })
    await resolve(confirmation, true)

    const signIn = await card('mcp_sign_in', (p) => p.status === 'pending')
    expect(signIn.payload).toMatchObject({ serverName: 'Notion', botId: chiefId, status: 'pending' })
    expect(signIn.content).not.toContain('http')
    const authorize = await fetch(signIn.payload.authorizationUrl as string, { redirect: 'manual' })
    const callback = authorize.headers.get('location') as string
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?code=/)
    expect((await fetch(callback)).status).toBe(200)
    await host.idle()

    const result = toolResults()[0]
    expect(result).toContain('It needs the user to sign in (OAuth)')
    expect(result).toMatch(/Signed in to Notion as ana@example\.com: 3 tools/)
    expect(result).toContain('reach all bots')
    expect((await card('mcp_sign_in')).payload).toMatchObject({
      status: 'connected',
      account: 'ana@example.com',
    })
    expect((await servers())[0]).toMatchObject({ allowedBots: 'all', oauth: { connected: true } })
  })

  it('tells the bot when the sign-in fails', async () => {
    oauth = await startOAuthMcpServer()
    await boot([{ toolCalls: [{ name: 'mcp_server_connect', arguments: { server: 'notion' } }] }])
    await call('createMcpServer', {}, { name: 'Notion', transport: 'http', url: oauth.url })
    await call('postMessage', { conversationId: chiefDm }, { content: 'sign in to Notion' })
    const signIn = await card('mcp_sign_in', (p) => p.status === 'pending')
    const authorization = new URL(signIn.payload.authorizationUrl as string)
    const redirect = authorization.searchParams.get('redirect_uri') as string
    const state = authorization.searchParams.get('state') as string
    const denied = await fetch(`${redirect}?state=${state}&error=access_denied&error_description=denied`)
    expect(denied.status).toBe(400)
    await host.idle()
    expect(toolResults()[0]).toMatch(/The sign-in to Notion failed: denied\. Offer to try again/)
    expect((await card('mcp_sign_in')).payload).toMatchObject({ status: 'failed', error: 'denied' })
  })

  it('reports a rejection, and an approval that comes after the tool stopped waiting as a new turn', async () => {
    const url = await startHttp(TOKEN)
    await boot([
      { toolCalls: [{ name: 'mcp_server_remove', arguments: { server: 'Tracker' } }] },
      {
        toolCalls: [
          { name: 'mcp_server_update', arguments: { server: 'Tracker', name: 'Tracker 2', bots: ['all'] } },
        ],
      },
      { text: 'Waiting for the user.' },
      { text: 'Renamed.' },
    ])
    const created = await call<McpServer>(
      'createMcpServer',
      {},
      {
        name: 'Tracker',
        transport: 'http',
        url,
        headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}`, secret: true }],
        allowedBots: [chiefId],
      },
    )
    await call('postMessage', { conversationId: chiefDm }, { content: 'remove the tracker' })
    await resolve(await pendingConfirmation('mcp_remove'), false)

    h.store.settings.set(USER_REQUEST_TIMEOUT_KEY, 0.05)
    const change = await pendingConfirmation('mcp_update')
    expect(JSON.parse((change.payload.params as Record<string, string>).details as string)).toEqual({
      name: 'Tracker 2',
      bots: 'all',
    })
    await until(() => requests.length >= 3, 8000)
    expect(toolResults()[0]).toContain('The user rejected removing the MCP server Tracker. Nothing changed.')
    expect(toolResults()[1]).toContain('You get a note with the outcome when they do')

    await resolve(change, true)
    await until(() => requests.length >= 4, 8000)
    await host.idle()
    expect(JSON.stringify(requests[3]?.messages)).toContain(
      '[Milibot] Changed the MCP server Tracker 2 (now for all bots)',
    )
    expect(await servers()).toMatchObject([{ id: created.id, name: 'Tracker 2', allowedBots: 'all' }])
    expect(await secrets.get(h.workspaceId, `mcp.${created.id}.header.Authorization`)).toBe(`Bearer ${TOKEN}`)
  })
})
