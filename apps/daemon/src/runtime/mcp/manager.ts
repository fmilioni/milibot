import { STATUS_CODES } from 'node:http'

import type { McpHttpKind, McpServerConfig, McpToolInfo } from '@milibot/agent'
import { argsObject } from '@milibot/agent/tools'
import type { McpServerState } from '@milibot/shared'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { detectOAuth, isAuthRequired, McpAuthRequiredError } from './oauth-client'
import { type GuestProcBackend, GuestProcTransport } from './proc-transport'
import type { McpCallResult } from './result'

export interface McpManagerDeps {
  /** Process API of the VM; may boot it (a turn or a test needs the server now). */
  procs(): Promise<GuestProcBackend>
  /** Process API only if the VM is already running (background reconnects never boot it). */
  runningProcs(): GuestProcBackend | null
  loadConfig(serverId: string): Promise<McpServerConfig | null>
  onState(serverId: string, state: McpServerState): void
  onTools(serverId: string, tools: McpToolInfo[], httpKind: McpHttpKind | null): void
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void
  version?: string
  connectTimeoutMs?: { stdio: number; http: number }
  callTimeoutMs?: number
  fetch?: FetchLike
  /** Delays of the automatic reconnects after a connection drops (the last one repeats). */
  reconnectDelaysMs?: number[]
  /** OAuth client (stored tokens, refresh) of a server with `oauth`; never opens a browser. */
  oauthProvider?: (config: McpServerConfig) => OAuthClientProvider
  /** A server needs the user to sign in (again); `detected`: it was not known to use OAuth. */
  onAuthRequired?: (serverId: string, detected: boolean) => void
  /** Removes secret values (e.g. a header a server echoes back) from an error before it is reported. */
  redact?: (text: string) => string
}

interface Connection {
  client: Client
  transport: Transport
  httpKind: McpHttpKind | null
  tools: McpToolInfo[] | null
  /** Closed on purpose (config change, shutdown): no reconnect. */
  closing: boolean
}

interface Entry {
  connection: Connection | null
  pending: Promise<Connection> | null
  state: McpServerState
  reconnectTimer: NodeJS.Timeout | null
  reconnectAttempt: number
  /** Bumped on reset/remove so late connections of an old config are discarded. */
  generation: number
}

const DEFAULT_CONNECT_TIMEOUT = { stdio: 120_000, http: 30_000 }
const DEFAULT_CALL_TIMEOUT = 300_000
const DEFAULT_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000]
const MAX_RECONNECT_ATTEMPTS = 8

function errorMessage(err: unknown): string {
  if (isAuthRequired(err)) return 'Sign-in required'
  const message = (err instanceof Error ? err.message : String(err)).replace(/^MCP error -?\d+: /, '')
  const status = (err as { code?: unknown } | null)?.code
  if (typeof status === 'number' && status >= 400 && status < 600) {
    // HTTP transport errors carry the status; their message often has an empty body after it.
    const detail = message
      .replace(/^(Streamable HTTP error|SSE error):\s*/i, '')
      .replace(/^(Error POSTing to endpoint|Non-200 status code \(\d+\)):?\s*/i, '')
      .trim()
    const reason = STATUS_CODES[status]
    return `HTTP ${status}${reason ? ` ${reason}` : ''}${detail ? `: ${detail}` : ''}`.slice(0, 1000)
  }
  return message.slice(0, 1000)
}

/**
 * MCP clients of the external servers of a workspace. Connections are opened on first use, kept
 * open and reopened with backoff when they drop; state changes are reported to the daemon.
 */
export class McpManager {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number
  private closed = false

  constructor(private readonly deps: McpManagerDeps) {
    this.now = deps.now ?? Date.now
  }

  private entry(serverId: string): Entry {
    let entry = this.entries.get(serverId)
    if (!entry) {
      entry = {
        connection: null,
        pending: null,
        state: { status: 'idle', error: null, since: this.now() },
        reconnectTimer: null,
        reconnectAttempt: 0,
        generation: 0,
      }
      this.entries.set(serverId, entry)
    }
    return entry
  }

  state(serverId: string): McpServerState {
    return this.entries.get(serverId)?.state ?? { status: 'idle', error: null, since: this.now() }
  }

  private setState(serverId: string, status: McpServerState['status'], error: string | null = null): void {
    const entry = this.entry(serverId)
    if (error !== null && this.deps.redact) error = this.deps.redact(error)
    if (entry.state.status === status && entry.state.error === error) return
    entry.state = { status, error, since: this.now() }
    this.deps.onState(serverId, entry.state)
  }

  /**
   * What callers get instead of `err`: a new error with the secrets removed from its message. The
   * original is dropped (not kept as `cause`), since its message and stack may hold an echoed secret.
   */
  private redacted(err: unknown): unknown {
    if (!this.deps.redact || isAuthRequired(err)) return err
    return new Error(this.deps.redact(errorMessage(err)))
  }

  /** Open connection to the server, connecting if needed (`boot`: may start the VM). */
  async connection(serverId: string, { boot = true } = {}): Promise<Connection> {
    if (this.closed) throw new Error('MCP manager closed')
    const entry = this.entry(serverId)
    if (entry.connection) return entry.connection
    if (entry.pending) return entry.pending
    const generation = entry.generation
    const pending = (async () => {
      const config = await this.deps.loadConfig(serverId)
      if (!config) throw new Error('MCP server not found')
      if (!config.enabled) {
        this.setState(serverId, 'disabled')
        throw new Error(`${config.name} is disabled`)
      }
      this.setState(serverId, 'connecting')
      let connection: Connection
      try {
        connection = await this.open(config, boot)
      } catch (err) {
        if (entry.generation === generation) {
          if (isAuthRequired(err)) {
            this.setState(serverId, 'needs_auth')
            this.deps.onAuthRequired?.(serverId, err instanceof McpAuthRequiredError && err.detected)
          } else this.setState(serverId, 'error', errorMessage(err))
        }
        throw this.redacted(err)
      }
      if (entry.generation !== generation || this.closed) {
        connection.closing = true
        await connection.client.close().catch(() => undefined)
        throw new Error('MCP server configuration changed while connecting')
      }
      entry.connection = connection
      entry.reconnectAttempt = 0
      connection.client.onclose = () => this.dropped(serverId, connection)
      connection.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        connection.tools = null
        void this.listTools(serverId, { refresh: true }).catch(() => undefined)
      })
      this.setState(serverId, 'connected')
      return connection
    })()
    entry.pending = pending
    try {
      return await pending
    } finally {
      if (entry.pending === pending) entry.pending = null
    }
  }

  private dropped(serverId: string, connection: Connection): void {
    const entry = this.entries.get(serverId)
    if (!entry || entry.connection !== connection) return
    entry.connection = null
    if (connection.closing || this.closed) return
    this.deps.log?.('warn', 'mcp server connection closed', { serverId })
    this.setState(serverId, 'error', entry.state.error ?? 'connection closed')
    this.scheduleReconnect(serverId)
  }

  private scheduleReconnect(serverId: string): void {
    const entry = this.entry(serverId)
    if (entry.reconnectTimer || entry.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return
    const delays = this.deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS
    const delay = delays[Math.min(entry.reconnectAttempt, delays.length - 1)] ?? 60_000
    entry.reconnectAttempt++
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      if (this.closed || entry.connection || entry.pending) return
      this.connection(serverId, { boot: false })
        .then(() => this.listTools(serverId, { refresh: true }))
        .catch((err: unknown) => {
          // Retrying can't help until the user signs in again.
          if (!isAuthRequired(err)) this.scheduleReconnect(serverId)
        })
    }, delay)
    entry.reconnectTimer.unref?.()
  }

  private async open(config: McpServerConfig, boot: boolean): Promise<Connection> {
    const timeouts = this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT
    if (config.transport === 'stdio_vm') {
      if (!config.command) throw new Error('missing command')
      const backend = boot ? await this.deps.procs() : this.deps.runningProcs()
      if (!backend) throw new Error('the workspace VM is not running')
      const transport = new GuestProcTransport(backend, {
        argv: [config.command, ...config.args],
        env: config.env,
        label: `mcp:${config.slug}`,
      })
      const client = this.newClient(config)
      try {
        await client.connect(transport, { timeout: timeouts.stdio })
      } catch (err) {
        await transport.close().catch(() => undefined)
        const tail = transport.stderrTail.split('\n').slice(-5).join('\n')
        const message = errorMessage(err)
        throw new Error(tail && !message.includes(tail) ? `${message}\n${tail}` : message, { cause: err })
      }
      return { client, transport, httpKind: null, tools: null, closing: false }
    }
    if (!config.url) throw new Error('missing URL')
    const url = new URL(config.url)
    const requestInit: RequestInit = { headers: config.headers }
    const fetchOption = this.deps.fetch ? { fetch: this.deps.fetch } : {}
    const authProvider = config.oauth ? this.deps.oauthProvider?.(config) : undefined
    const authOption = authProvider ? { authProvider } : {}
    const streamable = new StreamableHTTPClientTransport(url, { requestInit, ...fetchOption, ...authOption })
    const client = this.newClient(config)
    try {
      await client.connect(streamable, { timeout: timeouts.http })
      return { client, transport: streamable, httpKind: 'streamable', tools: null, closing: false }
    } catch (err) {
      await client.close().catch(() => undefined)
      if (isAuthRequired(err)) throw err
      const status = err instanceof StreamableHTTPError ? err.code : undefined
      if (status === 401 && !config.oauth && (await detectOAuth(config.url, this.deps.fetch)))
        throw new McpAuthRequiredError('This server signs in with OAuth', true)
      if (status === 401 || status === 403) throw new Error(errorMessage(err), { cause: err })
      // Servers of the 2024-11-05 spec only speak HTTP+SSE.
      const sse = new SSEClientTransport(url, {
        requestInit,
        eventSourceInit: { fetch: this.withHeaders(config.headers) },
        ...fetchOption,
        ...authOption,
      })
      const fallback = this.newClient(config)
      const sseError = await fallback.connect(sse, { timeout: timeouts.http }).then(
        () => null,
        (e: unknown) => e ?? new Error('SSE connection failed'),
      )
      if (sseError === null)
        return { client: fallback, transport: sse, httpKind: 'sse', tools: null, closing: false }
      await fallback.close().catch(() => undefined)
      if (isAuthRequired(sseError)) throw sseError
      throw new Error(errorMessage(err), { cause: err })
    }
  }

  private withHeaders(headers: Record<string, string>): FetchLike {
    const base = this.deps.fetch ?? fetch
    return (url, init) => {
      const merged = new Headers(init?.headers)
      for (const [name, value] of Object.entries(headers)) merged.set(name, value)
      return base(url, { ...init, headers: merged })
    }
  }

  /**
   * Declares roots and elicitation like Claude Code does, so servers list the same tools for both
   * (some only register tools for clients with these capabilities). Nobody answers questions:
   * elicitations are declined.
   */
  private newClient(config: McpServerConfig): Client {
    const client = new Client(
      { name: 'milibot', version: this.deps.version ?? 'dev' },
      { capabilities: { roots: { listChanged: false }, elicitation: {} } },
    )
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: config.transport === 'stdio_vm' ? [{ uri: 'file:///workspace', name: 'workspace' }] : [],
    }))
    client.setRequestHandler(ElicitRequestSchema, () => ({ action: 'decline' as const }))
    return client
  }

  private async fetchTools(connection: Connection): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const result = await connection.client.listTools(cursor ? { cursor } : undefined)
      for (const tool of result.tools) {
        tools.push({
          name: tool.name,
          description: tool.description ?? tool.title ?? '',
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })
      }
      cursor = result.nextCursor
      if (!cursor) break
    }
    return tools
  }

  /** Tools of the server (from the open connection; `refresh` asks the server again). */
  async listTools(serverId: string, { refresh = false, boot = true } = {}): Promise<McpToolInfo[]> {
    const connection = await this.connection(serverId, { boot })
    if (connection.tools && !refresh) return connection.tools
    try {
      connection.tools = await this.fetchTools(connection)
    } catch (err) {
      this.setState(serverId, 'error', errorMessage(err))
      throw this.redacted(err)
    }
    this.deps.onTools(serverId, connection.tools, connection.httpKind)
    return connection.tools
  }

  async callTool(
    serverId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const call = async () => {
      const connection = await this.connection(serverId)
      return (await connection.client.callTool({ name: tool, arguments: argsObject(args) }, undefined, {
        ...(signal ? { signal } : {}),
        timeout: this.deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT,
        resetTimeoutOnProgress: true,
      })) as McpCallResult
    }
    try {
      return await call()
    } catch (err) {
      // The HTTP session expired on the server: the request was refused, not run. Reconnect once.
      if (err instanceof StreamableHTTPError && err.code === 404) {
        await this.reset(serverId)
        return call().catch((retryErr: unknown) => {
          throw this.redacted(retryErr)
        })
      }
      throw this.redacted(err)
    }
  }

  /**
   * Connects to a configuration that is not (or not yet) saved, lists its tools and disconnects.
   * The persistent connection of the server, if any, is left alone.
   */
  async test(config: McpServerConfig): Promise<{ tools: McpToolInfo[]; httpKind: McpHttpKind | null }> {
    const connection = await this.open(config, true).catch((err: unknown) => {
      throw this.redacted(err)
    })
    connection.closing = true
    try {
      return { tools: await this.fetchTools(connection), httpKind: connection.httpKind }
    } catch (err) {
      throw this.redacted(err)
    } finally {
      await connection.client.close().catch(() => undefined)
    }
  }

  /** The configuration changed: the next use reconnects with the new one. */
  async reset(serverId: string, status: McpServerState['status'] = 'idle'): Promise<void> {
    const entry = this.entry(serverId)
    entry.generation++
    entry.pending = null
    entry.reconnectAttempt = 0
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
    entry.reconnectTimer = null
    const connection = entry.connection
    entry.connection = null
    if (connection) {
      connection.closing = true
      await connection.client.close().catch(() => undefined)
    }
    this.setState(serverId, status)
  }

  async remove(serverId: string): Promise<void> {
    await this.reset(serverId)
    this.entries.delete(serverId)
  }

  async closeAll(): Promise<void> {
    this.closed = true
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer)
        const connection = entry.connection
        entry.connection = null
        if (connection) {
          connection.closing = true
          await connection.client.close().catch(() => undefined)
        }
      }),
    )
  }
}
