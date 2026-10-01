import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { afterEach, describe, expect, it } from 'vitest'

import { AGY_MCP_BRIDGE_SCRIPT } from '../../../../src/runtime/providers/cli-engines/scripts/agy-mcp-bridge.generated'
import { useTempDir } from '../../../support/temp'

/** A streamable HTTP MCP server answering `tools/call` as an SSE stream, with the bearer token it got. */
function httpServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c))
    req.on('end', () => {
      const message = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string } }
      if (message.id === undefined) return res.writeHead(202).end()
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'm', version: '1' },
            }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'memory_save', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: `${message.params?.name} ${req.headers.authorization}` }] }
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
      if (message.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`event: message\ndata: ${body}\n\n`)
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(body)
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` })
    }),
  )
}

/** A stdio MCP server with two tools. */
const STDIO_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} }
    : m.method === 'tools/list' ? { tools: [{ name: 'search', inputSchema: {} }, { name: 'delete', inputSchema: {} }] }
    : { content: [{ type: 'text', text: 'ext:' + m.params.name + ':' + JSON.stringify(m.params.arguments) }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n')
})
`

describe('agy MCP bridge', () => {
  const dir = useTempDir('agy-bridge')
  let bridge: ChildProcessWithoutNullStreams | null = null
  let http: Server | null = null

  afterEach(() => {
    bridge?.kill()
    http?.close()
  })

  function start(env: Record<string, string>) {
    const script = join(dir(), 'bridge.js')
    writeFileSync(script, AGY_MCP_BRIDGE_SCRIPT)
    bridge = spawn(process.execPath, [script], { env: { ...process.env, ...env }, windowsHide: true })
    const answers = new Map<number, (value: unknown) => void>()
    createInterface({ input: bridge.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as { id: number }
      answers.get(message.id)?.(message)
    })
    let id = 0
    return (method: string, params: unknown = {}) =>
      new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
        answers.set(++id, resolve as (value: unknown) => void)
        bridge?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
  }

  it("joins Milibot's server and the bot's others for one lane, hiding switched-off tools", async () => {
    const started = await httpServer()
    http = started.server
    const config = join(dir(), 'mcp.json')
    const stdio = join(dir(), 'server.js')
    writeFileSync(stdio, STDIO_SERVER)
    writeFileSync(
      config,
      JSON.stringify({
        servers: {
          notes: { type: 'stdio', command: process.execPath, args: [stdio], disabledTools: ['delete'] },
          milibot: { type: 'http', url: started.url, headers: { Authorization: 'Bearer lane-token' } },
        },
      }),
    )
    const call = start({ MILIBOT_MCP_CONFIG: config })
    expect((await call('initialize', { protocolVersion: '2025-11-25' })).result).toMatchObject({
      serverInfo: { name: 'milibot' },
    })
    const listed = (await call('tools/list')).result?.tools as Array<{ name: string }>
    expect(listed.map((t) => t.name).sort()).toEqual(['memory_save', 'notes__search'])
    expect((await call('tools/call', { name: 'memory_save', arguments: {} })).result).toEqual({
      content: [{ type: 'text', text: 'memory_save Bearer lane-token' }],
    })
    expect((await call('tools/call', { name: 'notes__search', arguments: { q: 1 } })).result).toEqual({
      content: [{ type: 'text', text: 'ext:search:{"q":1}' }],
    })
  })

  it('serves no tools without a lane config (agy run by hand)', async () => {
    const call = start({ MILIBOT_MCP_CONFIG: '' })
    await call('initialize')
    expect((await call('tools/list')).result).toEqual({ tools: [] })
    expect((await call('tools/call', { name: 'memory_save' })).error?.message).toBe(
      'unknown tool memory_save',
    )
  })
})
