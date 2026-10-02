import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { laneInfo, type LaneKey, type ToolResult } from '@milibot/agent'
import { CLI_ENGINE_DRIVERS } from '@milibot/agent/cli'
import { type BlobReader, toBase64, type ToolCall } from '@milibot/agent/llm'
import { mcpInstructions } from '@milibot/agent/prompts'
import { toolsForLane } from '@milibot/agent/tools'
import { type Bot, type CliEngine, GUEST_NET, type LogFn } from '@milibot/shared'

import { errorMessage } from '../../errors'

/** The guest address gvproxy maps to the host's loopback interface. */
export const GUEST_HOST_ADDRESS = GUEST_NET.host
const PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY = 4 * 1024 * 1024

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

/** OAuth-protected external servers, served to the CLI engines at `/mcp/x/<slug>` with Milibot's signed-in client. */
interface McpOAuthProxy {
  tools(
    botId: string,
    slug: string,
  ): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> | null>
  call(botId: string, slug: string, tool: string, args: unknown): Promise<unknown>
}

export interface McpToolServerDeps {
  getBot(botId: string): Bot | null
  /** `laneKey`: the bot lane whose token made the call (its turn runs the tool). */
  runTool(botId: string, call: ToolCall, laneKey: LaneKey): Promise<ToolResult>
  /** Tool families of the bot's active skills (absent: every tool). */
  enabledFamilies?(bot: Bot): ReadonlySet<string>
  /** A read-only helper lane: no tool that changes files, the team or the bot's persona. */
  readOnlyLane?(laneKey: LaneKey): boolean
  proxy?: McpOAuthProxy
  /**
   * Documents of `GET /render/<token>/<path>` (design frames for the renderer's Chrome; no bearer: the
   * token in the path is the credential). Null = 404.
   */
  render?(
    token: string,
    path: string,
    query: URLSearchParams,
  ): Promise<{ status: number; body: string } | null>
  blobs: BlobReader
  version: string
  port?: number
  log?: LogFn
}

/**
 * Milibot tools for the CLI engines (Claude Code, Codex) running inside the VM, as an MCP server over
 * streamable HTTP (JSON responses, no SSE). Bound to 127.0.0.1: the guest reaches it through 10.0.2.2. Every
 * request needs a bearer token, one per bot lane and engine, which also identifies the calling bot, lane and
 * engine (whose native tools are left out).
 */
export class McpToolServer {
  private server: Server | null = null
  private port = 0
  private readonly tokens = new Map<string, { botId: string; laneKey: LaneKey; engine: CliEngine }>()

  constructor(private readonly deps: McpToolServerDeps) {}

  async listen(): Promise<number> {
    if (this.server) return this.port
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.deps.log?.('error', 'mcp request failed', { err: errorMessage(err) })
        if (!res.headersSent) this.send(res, 500, { error: 'internal' })
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.deps.port ?? 0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('unexpected MCP server address')
    this.server = server
    this.port = address.port
    return this.port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    // Keep-alive connections (the renderer's Chrome) would hold close() open.
    server.closeAllConnections()
    await closed
  }

  get localUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  async endpointFor(
    botId: string,
    laneKey: LaneKey,
    engine: CliEngine,
  ): Promise<{ url: string; token: string }> {
    const port = await this.listen()
    return { url: `http://${GUEST_HOST_ADDRESS}:${port}/mcp`, token: this.tokenFor(botId, laneKey, engine) }
  }

  /** Base URL of this server as seen from the VM (or `host`), listening first. */
  async baseUrl(host: string = GUEST_HOST_ADDRESS): Promise<string> {
    return `http://${host}:${await this.listen()}`
  }

  /** The proxy of the OAuth servers for one bot, as the CLI engines see it from the VM. */
  async proxyEndpointFor(
    botId: string,
    engine: CliEngine,
  ): Promise<{ url(slug: string): string; token: string }> {
    const { url, token } = await this.endpointFor(botId, botId, engine)
    return { url: (slug) => `${url}/x/${encodeURIComponent(slug)}`, token }
  }

  tokenFor(botId: string, laneKey: LaneKey, engine: CliEngine): string {
    for (const [token, owner] of this.tokens)
      if (owner.laneKey === laneKey && owner.engine === engine) return token
    const token = randomBytes(32).toString('hex')
    this.tokens.set(token, { botId, laneKey, engine })
    return token
  }

  /** Invalidates the token of a lane that ended (a finished work session). */
  revokeLane(laneKey: LaneKey): void {
    for (const [token, owner] of this.tokens) if (owner.laneKey === laneKey) this.tokens.delete(token)
  }

  private authenticate(
    header: string | undefined,
  ): { botId: string; laneKey: LaneKey; engine: CliEngine } | null {
    const received = header?.startsWith('Bearer ') ? header.slice(7) : ''
    if (!received) return null
    for (const [token, owner] of this.tokens) {
      const a = Buffer.from(token)
      const b = Buffer.from(received)
      if (a.length === b.length && timingSafeEqual(a, b)) return owner
    }
    return null
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status)
      res.end()
      return
    }
    const data = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length })
    res.end(data)
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw new Error('body too large')
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mcp')
    const render = /^\/render\/([0-9a-f]{48})\/([A-Za-z0-9_]+)$/.exec(url.pathname)
    if (render && this.deps.render) {
      if (req.method !== 'GET') return this.send(res, 405)
      const doc = await this.deps.render(render[1] as string, render[2] as string, url.searchParams)
      if (!doc) return this.send(res, 404, { error: 'not found' })
      const data = Buffer.from(doc.body)
      res.writeHead(doc.status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': data.length,
        'cache-control': 'no-store',
      })
      res.end(data)
      return
    }
    const proxied = /^\/mcp\/x\/([a-z0-9][a-z0-9_-]*)$/.exec(url.pathname)?.[1] ?? null
    if (url.pathname !== '/mcp' && !(proxied && this.deps.proxy))
      return this.send(res, 404, { error: 'not found' })
    const caller = this.authenticate(req.headers.authorization)
    if (!caller) return this.send(res, 401, { error: 'unauthorized' })
    if (req.method === 'DELETE') return this.send(res, 200)
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST, DELETE')
      return this.send(res, 405)
    }
    let payload: unknown
    try {
      payload = JSON.parse(await this.readBody(req))
    } catch {
      return this.send(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })
    }
    const batch = Array.isArray(payload)
    const requests = (batch ? payload : [payload]) as JsonRpcRequest[]
    const responses = []
    for (const request of requests) {
      const response = proxied
        ? await this.dispatchProxy(caller.botId, proxied, request)
        : await this.dispatch(caller.botId, caller.laneKey, caller.engine, request)
      if (response) responses.push(response)
    }
    if (responses.length === 0) return this.send(res, 202)
    return this.send(res, 200, batch ? responses : responses[0])
  }

  private async dispatchProxy(botId: string, slug: string, request: JsonRpcRequest): Promise<unknown> {
    const proxy = this.deps.proxy as McpOAuthProxy
    const isNotification = request.id === undefined || request.id === null
    const reply = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id: request.id, result })
    const fail = (code: number, message: string) =>
      isNotification ? null : { jsonrpc: '2.0', id: request.id, error: { code, message } }
    switch (request.method) {
      case 'initialize':
        return reply({
          protocolVersion:
            typeof request.params?.protocolVersion === 'string'
              ? request.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: slug, version: this.deps.version },
        })
      case 'ping':
        return reply({})
      case 'tools/list': {
        try {
          const tools = await proxy.tools(botId, slug)
          if (!tools) return fail(-32001, `${slug} is not available to this bot`)
          return reply({ tools })
        } catch (err) {
          return fail(-32002, errorMessage(err))
        }
      }
      case 'tools/call': {
        const name = request.params?.name
        if (typeof name !== 'string') return fail(-32602, 'missing tool name')
        return reply(await proxy.call(botId, slug, name, request.params?.arguments ?? {}))
      }
      default:
        if (request.method.startsWith('notifications/')) return null
        return fail(-32601, `Method not found: ${request.method}`)
    }
  }

  private async dispatch(
    botId: string,
    laneKey: LaneKey,
    engine: CliEngine,
    request: JsonRpcRequest,
  ): Promise<unknown> {
    const isNotification = request.id === undefined || request.id === null
    const reply = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id: request.id, result })
    const fail = (code: number, message: string) =>
      isNotification ? null : { jsonrpc: '2.0', id: request.id, error: { code, message } }
    const bot = this.deps.getBot(botId)
    if (!bot) return fail(-32001, 'bot not found')
    const families = this.deps.enabledFamilies?.(bot)
    const tools = () =>
      toolsForLane(laneInfo(laneKey).kind, {
        native: CLI_ENGINE_DRIVERS[engine].nativeInMcp,
        readOnly: this.deps.readOnlyLane?.(laneKey) ?? false,
        ...(families ? { enabledFamilies: families } : {}),
      })
    switch (request.method) {
      case 'initialize':
        return reply({
          protocolVersion:
            typeof request.params?.protocolVersion === 'string'
              ? request.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'milibot', version: this.deps.version },
          instructions: mcpInstructions(bot.name, tools()),
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: tools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        })
      case 'tools/call': {
        const name = request.params?.name
        if (typeof name !== 'string') return fail(-32602, 'missing tool name')
        const allowed = tools().some((t) => t.name === name)
        if (!allowed)
          return reply({ content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true })
        const result = await this.deps.runTool(
          botId,
          { id: `mcp_${randomBytes(6).toString('hex')}`, name, arguments: request.params?.arguments ?? {} },
          laneKey,
        )
        const content = []
        for (const part of result.content) {
          if (part.type === 'text') content.push({ type: 'text', text: part.text })
          else
            content.push({
              type: 'image',
              data: toBase64(await this.deps.blobs.read(part.sha256)),
              mimeType: part.mediaType,
            })
        }
        return reply({ content, isError: result.isError ?? false })
      }
      default:
        if (request.method.startsWith('notifications/')) return null
        return fail(-32601, `Method not found: ${request.method}`)
    }
  }
}
