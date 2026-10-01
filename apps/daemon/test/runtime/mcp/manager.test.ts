import type { BlobStore, McpServerConfig, McpToolInfo } from '@milibot/agent'
import type { GuestProcEvent } from '@milibot/agent/cli'
import { toBase64 } from '@milibot/agent/llm'
import { MemoryBlobStore, solidPng } from '@milibot/agent/testing'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { jpegSize } from '../../../src/runtime/files/image-size'
import { McpManager } from '../../../src/runtime/mcp/manager'
import { type GuestProcBackend, GuestProcTransport } from '../../../src/runtime/mcp/proc-transport'
import { mapMcpResult } from '../../../src/runtime/mcp/result'

function testServer(): McpServer {
  const server = new McpServer({ name: 'test', version: '1.0.0' })
  server.registerTool(
    'echo',
    { description: 'Echoes the text', inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  )
  server.registerTool(
    'add',
    { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )
  server.registerTool('boom', { description: 'Always fails' }, async () => ({
    content: [{ type: 'text', text: 'nope' }],
    isError: true,
  }))
  return server
}

interface FakeProc {
  id: string
  events: GuestProcEvent[]
  wake: Array<() => void>
  serverSide: InMemoryTransport
  stdinBuffer: string
  exited: boolean
}

/**
 * Guest `/procs` API whose "process" is an in-memory MCP server: stdin lines go to the server,
 * its messages come back as stdout events. `breakStreamAfter` makes the NDJSON stream fail once
 * after that many events (the transport must resume from the last seq).
 */
function fakeProcs(options: { breakStreamAfter?: number; stderr?: string; exitOnStart?: boolean } = {}) {
  const procs = new Map<string, FakeProc>()
  const started: Array<{ argv: string[]; env: Record<string, string>; label: string }> = []
  const signals: string[] = []
  let broken = false
  let seq = 0
  const push = (proc: FakeProc, event: GuestProcEvent) => {
    proc.events.push(event)
    for (const wake of proc.wake.splice(0)) wake()
  }
  const backend: GuestProcBackend = {
    async startProcess(spec) {
      started.push({ argv: spec.argv, env: spec.env, label: spec.label })
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      const proc: FakeProc = {
        id: `proc-${started.length}`,
        events: [],
        wake: [],
        serverSide,
        stdinBuffer: '',
        exited: false,
      }
      procs.set(proc.id, proc)
      clientSide.onmessage = (message: JSONRPCMessage) =>
        push(proc, { seq: ++seq, type: 'stdout', data: JSON.stringify(message) })
      await clientSide.start()
      await testServer().connect(serverSide)
      ;(proc as FakeProc & { clientSide: InMemoryTransport }).clientSide = clientSide
      push(proc, { seq: ++seq, type: 'stdout', data: 'npm notice: not JSON-RPC' })
      if (options.stderr) push(proc, { seq: ++seq, type: 'stderr', data: options.stderr })
      if (options.exitOnStart) {
        proc.exited = true
        push(proc, { seq: ++seq, type: 'exit', code: 1, signal: null })
      }
      return { id: proc.id }
    },
    events(procId, since, signal) {
      const proc = procs.get(procId) as FakeProc
      return {
        async *[Symbol.asyncIterator]() {
          let last = since
          let sent = 0
          for (;;) {
            const next = proc.events.find((e) => 'seq' in e && e.seq > last)
            if (next && 'seq' in next) {
              if (options.breakStreamAfter !== undefined && !broken && sent >= options.breakStreamAfter) {
                broken = true
                throw new TypeError('fetch failed')
              }
              last = next.seq
              sent++
              yield next
              if (next.type === 'exit') return
              continue
            }
            if (signal.aborted) return
            await new Promise<void>((resolve) => {
              proc.wake.push(resolve)
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          }
        },
      }
    },
    async writeStdin(procId, data, eof) {
      const proc = procs.get(procId) as FakeProc & { clientSide: InMemoryTransport }
      if (proc.exited) throw new Error('process has exited')
      proc.stdinBuffer += data
      let index: number
      while ((index = proc.stdinBuffer.indexOf('\n')) !== -1) {
        const line = proc.stdinBuffer.slice(0, index)
        proc.stdinBuffer = proc.stdinBuffer.slice(index + 1)
        await proc.clientSide.send(JSON.parse(line) as JSONRPCMessage)
      }
      if (eof) proc.exited = true
    },
    async signal(procId, signal) {
      signals.push(`${procId}:${signal}`)
      const proc = procs.get(procId) as FakeProc
      if (!proc.exited) {
        proc.exited = true
        push(proc, { seq: ++seq, type: 'exit', code: null, signal })
      }
    },
  }
  return { backend, started, signals, procs }
}

const stdioConfig = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'mcp_1',
  slug: 'test',
  name: 'Test',
  transport: 'stdio_vm',
  command: 'npx',
  args: ['-y', 'test-server'],
  url: null,
  env: { API_TOKEN: 'super-secret-token' },
  headers: {},
  enabled: true,
  ...overrides,
})

function manager(backend: GuestProcBackend, config = stdioConfig()) {
  const states: string[] = []
  const tools: McpToolInfo[][] = []
  const m = new McpManager({
    procs: async () => backend,
    runningProcs: () => backend,
    loadConfig: async (id) => (id === config.id ? config : null),
    onState: (_id, state) => states.push(state.error ? `${state.status}:${state.error}` : state.status),
    onTools: (_id, list) => tools.push(list),
    reconnectDelaysMs: [5],
  })
  return { m, states, tools }
}

describe('GuestProcTransport', () => {
  it('runs an MCP server through the /procs API: initialize, list tools, call tools', async () => {
    const fake = fakeProcs()
    const { m, states, tools } = manager(fake.backend)
    const listed = await m.listTools('mcp_1')
    expect(listed.map((t) => t.name).sort()).toEqual(['add', 'boom', 'echo'])
    expect(fake.started[0]).toMatchObject({
      argv: ['npx', '-y', 'test-server'],
      env: { API_TOKEN: 'super-secret-token' },
      label: 'mcp:test',
    })
    expect(states).toEqual(['connecting', 'connected'])
    expect(tools).toHaveLength(1)
    const sum = await m.callTool('mcp_1', 'add', { a: 2, b: 40 })
    expect(sum.content).toEqual([{ type: 'text', text: '42' }])
    const failed = await m.callTool('mcp_1', 'boom', {})
    expect(failed.isError).toBe(true)
    // Same connection: one process for all of it.
    expect(fake.started).toHaveLength(1)
    await m.closeAll()
    expect(fake.signals).toEqual(['proc-1:SIGTERM'])
  })

  it('resumes the event stream from the last sequence number after a network failure', async () => {
    const fake = fakeProcs({ breakStreamAfter: 2 })
    const transport = new GuestProcTransport(fake.backend, {
      argv: ['srv'],
      env: {},
      label: 'mcp:x',
      retryDelayMs: 1,
    })
    const { m } = manager(fake.backend)
    const listed = await m.listTools('mcp_1')
    expect(listed).toHaveLength(3)
    const echo = await m.callTool('mcp_1', 'echo', { text: 'hi' })
    expect(echo.content).toEqual([{ type: 'text', text: 'hi' }])
    await transport.close()
    await m.closeAll()
  })

  it('reports the exit with the stderr tail when the server dies on start', async () => {
    const fake = fakeProcs({ exitOnStart: true, stderr: 'npm ERR! 404 Not Found - test-server' })
    const { m, states } = manager(fake.backend)
    await expect(m.listTools('mcp_1')).rejects.toThrow(/404 Not Found/)
    expect(states.at(-1)).toMatch(/^error:.*404 Not Found/s)
    expect(m.state('mcp_1').status).toBe('error')
  })

  it('reconnects with backoff after the process exits', async () => {
    const fake = fakeProcs()
    const { m, states } = manager(fake.backend)
    await m.listTools('mcp_1')
    await fake.backend.signal('proc-1', 'SIGKILL')
    await until(() => fake.started.length === 2 && m.state('mcp_1').status === 'connected')
    expect(states).toContain('error:connection closed')
    const echo = await m.callTool('mcp_1', 'echo', { text: 'back again' })
    expect(echo.content).toEqual([{ type: 'text', text: 'back again' }])
    await m.closeAll()
  })

  it('reset closes the connection and the next use reconnects with the new config', async () => {
    const fake = fakeProcs()
    const { m } = manager(fake.backend)
    await m.listTools('mcp_1')
    await m.reset('mcp_1')
    expect(m.state('mcp_1').status).toBe('idle')
    await m.listTools('mcp_1')
    expect(fake.started).toHaveLength(2)
    await m.closeAll()
  })

  it('tests an unsaved configuration without touching the persistent connection', async () => {
    const fake = fakeProcs()
    const { m, states } = manager(fake.backend)
    const { tools } = await m.test(stdioConfig({ id: 'draft' }))
    expect(tools).toHaveLength(3)
    expect(states).toEqual([])
    expect(fake.signals).toEqual(['proc-1:SIGTERM'])
  })
})

async function until(check: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('result mapping', () => {
  it('maps text, images, resources and links', async () => {
    const blobs = new MemoryBlobStore() as unknown as BlobStore
    const png = solidPng(4, 3, [1, 2, 3])
    const result = await mapMcpResult(
      {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: toBase64(png), mimeType: 'image/png' },
          { type: 'image', data: 'AAAA', mimeType: 'image/webp' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'content' } },
          {
            type: 'resource',
            resource: { uri: 'file:///b.bin', blob: 'AAAA', mimeType: 'application/octet-stream' },
          },
          { type: 'resource_link', uri: 'https://x.dev/pr/1', name: 'PR #1' },
        ],
      },
      blobs,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(result.content[1]).toMatchObject({ type: 'image', mediaType: 'image/png', width: 4, height: 3 })
    expect(result.content[2]).toEqual({
      type: 'text',
      text: '[image image/webp, 3 bytes: format not supported]',
    })
    expect(result.content[3]).toEqual({ type: 'text', text: 'Resource file:///a.txt:\ncontent' })
    expect(result.content[4]).toEqual({
      type: 'text',
      text: '[resource file:///b.bin (application/octet-stream), 3 bytes]',
    })
    expect(result.content[5]).toEqual({ type: 'text', text: 'Link: https://x.dev/pr/1 (PR #1)' })
  })

  it('keeps errors and falls back to structured content', async () => {
    const blobs = new MemoryBlobStore() as unknown as BlobStore
    expect(await mapMcpResult({ content: [{ type: 'text', text: 'bad' }], isError: true }, blobs)).toEqual({
      content: [{ type: 'text', text: 'bad' }],
      isError: true,
    })
    expect(await mapMcpResult({ content: [], structuredContent: { n: 1 } }, blobs)).toEqual({
      content: [{ type: 'text', text: '{"n":1}' }],
    })
  })

  it('reads JPEG dimensions', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0,
    ])
    expect(jpegSize(jpeg)).toEqual({ width: 64, height: 32 })
  })
})

describe('HTTP errors', () => {
  it('reports the HTTP status of a refused connection', async () => {
    const m = new McpManager({
      procs: async () => {
        throw new Error('no VM')
      },
      runningProcs: () => null,
      loadConfig: async () => null,
      onState: () => undefined,
      onTools: () => undefined,
      fetch: async () => new Response('', { status: 401 }),
    })
    await expect(
      m.test(stdioConfig({ transport: 'http', command: null, url: 'http://127.0.0.1:9/mcp' })),
    ).rejects.toThrow('HTTP 401 Unauthorized')
  })
})
