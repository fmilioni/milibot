import type { ToolCall } from '@milibot/agent/llm'
import { MemoryBlobStore, solidPng } from '@milibot/agent/testing'
import { READ_ONLY_HELPER_TOOLS, TOOL_FAMILY_NAMES } from '@milibot/agent/tools'
import type { Bot } from '@milibot/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { McpToolServer } from '../../../src/runtime/mcp-server/server'

const bot = { id: 'bot_1', name: 'Ana', slug: 'ana' } as Bot
const blobs = new MemoryBlobStore()
const sha = blobs.add(solidPng(2, 2, [0, 0, 0]))
const calls: Array<{ botId: string; call: ToolCall; laneKey: string }> = []

const server = new McpToolServer({
  getBot: (id) => (id === bot.id ? bot : null),
  runTool: async (botId, call, laneKey) => {
    calls.push({ botId, call, laneKey })
    return {
      content: [
        { type: 'text', text: 'shot' },
        { type: 'image', sha256: sha, mediaType: 'image/png', width: 2, height: 2 },
      ],
    }
  },
  blobs,
  version: 'test',
  enabledFamilies: () => new Set(TOOL_FAMILY_NAMES.filter((f) => f !== 'team')),
  readOnlyLane: (laneKey) => laneKey === `${bot.id}:chat:sub:1`,
})

let url: string

async function rpc(body: unknown, token?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON-RPC assertions
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as Record<string, any>) : null }
}

beforeAll(async () => {
  await server.listen()
  url = server.localUrl
})

afterAll(() => server.close())

describe('McpToolServer', () => {
  it('binds to loopback and hands out guest-facing endpoints', async () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const endpoint = await server.endpointFor(bot.id, bot.id, 'claude_code')
    expect(endpoint.url).toMatch(/^http:\/\/10\.0\.2\.2:\d+\/mcp$/)
    expect(endpoint.token).toBe(server.tokenFor(bot.id, bot.id, 'claude_code'))
  })

  it('rejects requests without a valid per-bot token', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'f'.repeat(64))).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('speaks MCP: initialize, tools/list without native tools, tools/call with images', async () => {
    const token = server.tokenFor(bot.id, bot.id, 'claude_code')
    const init = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      },
      token,
    )
    expect(init.body).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'milibot' }, capabilities: { tools: {} } },
    })
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, token)).status).toBe(202)

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token)
    const names = (list.body?.result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('computer')
    expect(names).toContain('repo_checkout')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('create_bot')

    const call = await rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'computer', arguments: { action: 'screenshot' } },
      },
      token,
    )
    expect(calls[0]).toMatchObject({
      botId: bot.id,
      laneKey: bot.id,
      call: { name: 'computer', arguments: { action: 'screenshot' } },
    })
    expect(call.body?.result).toMatchObject({
      isError: false,
      content: [
        { type: 'text', text: 'shot' },
        { type: 'image', mimeType: 'image/png' },
      ],
    })

    const denied = await rpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_bot', arguments: {} } },
      token,
    )
    expect(denied.body?.result.isError).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('gives each lane of a bot its own token, which routes the call to that lane until revoked', async () => {
    const lane = `${bot.id}:wses_1`
    const endpoint = await server.endpointFor(bot.id, lane, 'claude_code')
    expect(endpoint.token).not.toBe(server.tokenFor(bot.id, bot.id, 'claude_code'))
    const call = () =>
      rpc(
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'list_bots', arguments: {} },
        },
        endpoint.token,
      )
    expect((await call()).status).toBe(200)
    expect(calls.at(-1)).toMatchObject({ botId: bot.id, laneKey: lane, call: { name: 'list_bots' } })

    server.revokeLane(lane)
    expect((await call()).status).toBe(401)
    expect(
      (
        await rpc(
          { jsonrpc: '2.0', id: 6, method: 'tools/list' },
          server.tokenFor(bot.id, bot.id, 'claude_code'),
        )
      ).status,
    ).toBe(200)
  })

  it('lists only the read-only tools in a read-only helper lane', async () => {
    const list = async (lane: string) => {
      const { token } = await server.endpointFor(bot.id, lane, 'claude_code')
      const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, token)
      return (res.body?.result.tools as Array<{ name: string }>).map((t) => t.name)
    }
    const readOnly = await list(`${bot.id}:chat:sub:1`)
    expect(readOnly.length).toBeGreaterThan(0)
    expect(readOnly.filter((name) => !(READ_ONLY_HELPER_TOOLS as readonly string[]).includes(name))).toEqual(
      [],
    )
    const helper = await list(`${bot.id}:chat:sub:2`)
    expect(helper.some((name) => !(READ_ONLY_HELPER_TOOLS as readonly string[]).includes(name))).toBe(true)
  })

  it('leaves out the native tools of the engine the lane token belongs to', async () => {
    const names = async (token: string) =>
      (
        (await rpc({ jsonrpc: '2.0', id: 30, method: 'tools/list' }, token)).body?.result.tools as Array<{
          name: string
        }>
      ).map((t) => t.name)
    const claude = await names(server.tokenFor(bot.id, bot.id, 'claude_code'))
    const codex = await names(server.tokenFor(bot.id, bot.id, 'codex'))
    expect(server.tokenFor(bot.id, bot.id, 'codex')).not.toBe(server.tokenFor(bot.id, bot.id, 'claude_code'))
    for (const native of ['bash', 'file_read', 'apply_patch', 'web_search']) {
      expect(claude).not.toContain(native)
      expect(codex).not.toContain(native)
    }
    expect(claude).not.toContain('web_fetch')
    expect(codex).toContain('web_fetch')
  })
})
