import {
  type BlobStore,
  type BotMcpServerView,
  type BotMcpToolSet,
  botMcpToolSet,
  type McpOAuthProxyEndpoint,
  type McpServerConfig,
  type McpToolInfo,
  mcpToolTokens,
  type ToolExecContext,
  type ToolResult,
} from '@milibot/agent'
import { CLI_ENGINE_DRIVERS, type CliMcpConfig } from '@milibot/agent/cli'
import {
  type Bot,
  type CliEngine,
  type CreateMcpServerBody,
  type LogFn,
  type mcpEndpoints,
  type McpServer,
  type McpServerState,
  type McpTestResult,
  redactSecrets,
  type UpdateMcpServerBody,
  type WorkspaceEvent,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { errorMessage, notFound } from '../../errors'
import type { EndpointHandlers, Parsed } from '../../handlers'
import type { SecretStore } from '../../secrets/secret-store'
import { GUEST_HOST_ADDRESS } from '../mcp-server'
import type { GuestClient, VmController } from '../vm'
import { McpManager } from './manager'
import { McpOAuthService, type McpSignInOutcome } from './oauth'
import { isAuthRequired } from './oauth-client'
import type { GuestProcBackend } from './proc-transport'
import { mapMcpResult } from './result'
import { McpStore } from './store'

/** A turn waits this long for a server that has never listed its tools before going without it. */
const FIRST_LIST_TIMEOUT_MS = 45_000

export interface McpDeps {
  db: Db
  workspaceId: string
  secrets: SecretStore
  vm: VmController
  blobs: BlobStore
  emit: (event: WorkspaceEvent) => void
  now: () => number
  getBot(botId: string): Bot | null
  version: string
  log: LogFn
  fetch?: typeof fetch
}

function procBackend(guest: () => GuestClient): GuestProcBackend {
  return {
    startProcess: async (spec) => guest().startProc({ ...spec }),
    events: (procId, since, signal) => ({
      async *[Symbol.asyncIterator]() {
        yield* guest().procEvents(procId, since, signal)
      },
    }),
    writeStdin: async (procId, data, eof) => {
      await guest().procStdin(procId, data, eof ?? false)
    },
    signal: async (procId, signal) => {
      await guest().procSignal(procId, signal)
    },
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms).unref?.()),
  ])

/** External MCP servers of the workspace: CRUD, connections, per-bot tool sets and tool calls. */
export class McpService {
  readonly store: McpStore
  readonly manager: McpManager
  readonly oauth: McpOAuthService
  private secretValues: string[] = []
  private orphansCleared = false
  private readonly firstListing = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: McpDeps) {
    this.store = new McpStore(deps.db, deps.workspaceId, deps.secrets, deps.now)
    this.oauth = new McpOAuthService({
      store: this.store,
      now: deps.now,
      fetch: deps.fetch,
      onChange: (id) => this.announce(id),
      onConnected: async (id) => {
        await this.manager.reset(id)
        await this.refreshSecrets()
        this.announce(id)
        await this.manager.listTools(id, { refresh: true }).catch(() => undefined)
      },
      log: deps.log,
    })
    const { vm } = deps
    this.manager = new McpManager({
      procs: async () => {
        await vm.guest()
        await this.clearOrphans()
        return procBackend(() => vm.runningGuest())
      },
      runningProcs: () => (vm.status().state === 'running' ? procBackend(() => vm.runningGuest()) : null),
      loadConfig: (id) => this.store.config(id),
      onState: (id) => this.announce(id),
      onTools: (id, tools, httpKind) => {
        this.store.saveTools(id, tools, httpKind)
        this.announce(id)
      },
      now: deps.now,
      version: deps.version,
      log: deps.log,
      fetch: deps.fetch,
      oauthProvider: (config) => this.oauth.provider(config),
      onAuthRequired: (id, detected) => {
        if (detected) this.oauth.markOAuth(id)
        this.announce(id)
      },
    })
  }

  async start(): Promise<void> {
    await this.refreshSecrets()
  }

  async stop(): Promise<void> {
    this.oauth.close()
    await this.manager.closeAll()
  }

  /** Stdio servers of a previous runtime (daemon restart) are still running in the VM. */
  private async clearOrphans(): Promise<void> {
    if (this.orphansCleared) return
    this.orphansCleared = true
    try {
      await this.deps.vm.runningGuest().killProcs('mcp:')
    } catch (err) {
      this.orphansCleared = false
      this.deps.log('warn', 'could not clear old MCP processes', { err: errorMessage(err) })
    }
  }

  private async refreshSecrets(): Promise<void> {
    const ids = this.store.stored().map((s) => s.id)
    this.secretValues = await Promise.all([this.store.secretValues(), this.oauth.secretValues(ids)])
      .then(([values, tokens]) => [...values, ...tokens])
      .catch(() => this.secretValues)
  }

  /** Removes the secret values of the servers from a logged payload. */
  redact<T>(value: T): T {
    return this.secretValues.length ? redactSecrets(value, this.secretValues) : value
  }

  private withOAuth(server: McpServer): McpServer {
    if (!server.oauth) return server
    return {
      ...server,
      oauth: {
        ...server.oauth,
        connected: server.oauth.connected && server.state.status !== 'needs_auth',
        authorizing: this.oauth.authorizing(server.id),
      },
    }
  }

  /** Servers often echo the request in their errors, credentials included. */
  private state(id: string): McpServerState {
    const state = this.manager.state(id)
    return state.error ? { ...state, error: this.redact(state.error) } : state
  }

  private server(id: string): McpServer {
    return this.withOAuth(this.store.get(id, this.state(id)))
  }

  private announce(id: string): void {
    if (!this.store.exists(id)) return
    this.deps.emit({ type: 'mcp.server.updated', payload: { server: this.server(id) } })
  }

  serverName(slug: string): string | null {
    return this.store.stored().find((s) => s.slug === slug)?.name ?? null
  }

  /** Enabled servers the bot may use and has switched on, with its tool switches. */
  private async views(bot: Bot): Promise<BotMcpServerView[]> {
    const prefs = new Map(this.store.botServers(bot.id).map((p) => [p.serverId, p]))
    const views: BotMcpServerView[] = []
    for (const server of this.store.stored()) {
      const pref = prefs.get(server.id)
      if (!server.enabled || !pref?.enabled) continue
      const config = await this.store.config(server.id)
      if (!config) continue
      views.push({
        config,
        tools: server.tools,
        disabledTools: new Set(pref.disabledTools),
        httpKind: server.httpKind,
        revision: server.revision,
      })
    }
    return views
  }

  /** Lists the tools of a server never listed before (bounded wait; the turn goes on without it). */
  private async ensureListed(view: BotMcpServerView): Promise<BotMcpServerView> {
    if (view.tools.length > 0 || this.store.stored().find((s) => s.id === view.config.id)?.tools.length)
      return view
    const id = view.config.id
    let pending = this.firstListing.get(id)
    if (!pending) {
      pending = this.manager.listTools(id).finally(() => this.firstListing.delete(id))
      this.firstListing.set(id, pending)
    }
    try {
      await withTimeout(pending, FIRST_LIST_TIMEOUT_MS)
    } catch (err) {
      this.deps.log('warn', 'external MCP server unavailable for this turn', {
        serverId: id,
        err: errorMessage(err),
      })
    }
    const tools = this.store.stored().find((s) => s.id === id)?.tools ?? []
    return { ...view, tools }
  }

  async toolSet(bot: Bot): Promise<BotMcpToolSet> {
    const views = await Promise.all((await this.views(bot)).map((v) => this.ensureListed(v)))
    return botMcpToolSet(views)
  }

  /** The bot's external servers in a CLI engine's config shape. */
  async cliConfig(bot: Bot, engine: CliEngine, oauthProxy?: McpOAuthProxyEndpoint): Promise<CliMcpConfig> {
    return CLI_ENGINE_DRIVERS[engine].externalMcp(await this.views(bot), GUEST_HOST_ADDRESS, oauthProxy)
  }

  /** An OAuth server the bot may use, by slug (the proxy the CLI engines talk to). */
  private async proxied(botId: string, slug: string): Promise<BotMcpServerView | null> {
    const bot = this.deps.getBot(botId)
    if (!bot) return null
    const view = (await this.views(bot)).find((v) => v.config.slug === slug)
    return view?.config.oauth ? view : null
  }

  /** Tools of an OAuth server for a CLI engine (null: not available to this bot). */
  async proxyTools(botId: string, slug: string): Promise<McpToolInfo[] | null> {
    const view = await this.proxied(botId, slug)
    if (!view) return null
    const tools = await this.manager.listTools(view.config.id)
    return tools.filter((t) => !view.disabledTools.has(t.name))
  }

  /** Calls a tool of an OAuth server with Milibot's signed-in client, on behalf of a CLI engine bot. */
  async proxyCall(botId: string, slug: string, tool: string, args: unknown): Promise<unknown> {
    const view = await this.proxied(botId, slug)
    if (!view || view.disabledTools.has(tool))
      return { content: [{ type: 'text', text: `Tool not available: ${tool}` }], isError: true }
    try {
      return await this.manager.callTool(view.config.id, tool, args)
    } catch (err) {
      const text = isAuthRequired(err)
        ? `${view.config.name} needs the user to sign in again (Settings › MCP › Reconnect).`
        : `Tool failed: ${this.redact(errorMessage(err))}`
      return { content: [{ type: 'text', text }], isError: true }
    }
  }

  /** Runs a `mcp__<server>__<tool>` tool of a server the bot has switched on. */
  async callTool(ctx: ToolExecContext, name: string, args: unknown): Promise<ToolResult> {
    const prefs = new Map(this.store.botServers(ctx.bot.id).map((p) => [p.serverId, p]))
    const views = this.store
      .stored()
      .filter((s) => s.enabled && prefs.get(s.id)?.enabled)
      .map((s) => ({
        config: { id: s.id, slug: s.slug, name: s.name },
        tools: s.tools,
        disabledTools: new Set(prefs.get(s.id)?.disabledTools ?? []),
        httpKind: s.httpKind,
        revision: s.revision,
      }))
    const ref = botMcpToolSet(views).index.get(name)
    if (!ref) return { content: [{ type: 'text', text: `Tool not available: ${name}` }], isError: true }
    const result = await this.manager.callTool(ref.serverId, ref.tool, args, ctx.signal)
    return mapMcpResult(result, this.deps.blobs)
  }

  private async testConfig(config: McpServerConfig): Promise<McpTestResult> {
    const started = this.deps.now()
    try {
      const { tools } = await this.manager.test(config)
      return {
        ok: true,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          tokens: mcpToolTokens(config.slug, t),
        })),
        error: null,
        latencyMs: this.deps.now() - started,
      }
    } catch (err) {
      return {
        ok: false,
        tools: [],
        error: this.redact(errorMessage(err)),
        latencyMs: null,
        ...(isAuthRequired(err) ? { authRequired: true } : {}),
      }
    }
  }

  listServers(): McpServer[] {
    return this.store.list((id) => this.state(id)).map((s) => this.withOAuth(s))
  }

  getServer(id: string): McpServer {
    this.requireServer(id)
    return this.server(id)
  }

  async createServer(body: Parsed<typeof CreateMcpServerBody>): Promise<McpServer> {
    this.checkBots(body.allowedBots)
    const id = await this.store.create(body)
    await this.refreshSecrets()
    const server = this.server(id)
    this.deps.emit({ type: 'mcp.server.updated', payload: { server } })
    return server
  }

  async updateServer(serverId: string, body: Parsed<typeof UpdateMcpServerBody>): Promise<McpServer> {
    this.checkBots(body.allowedBots)
    const previousUrl = this.store.get(serverId, this.manager.state(serverId)).url
    const { connectionChanged } = await this.store.update(serverId, body)
    if (this.store.get(serverId, this.manager.state(serverId)).url !== previousUrl)
      await this.oauth.forget(serverId)
    await this.refreshSecrets()
    if (connectionChanged) {
      const enabled = this.store.stored().find((s) => s.id === serverId)?.enabled ?? false
      await this.manager.reset(serverId, enabled ? 'idle' : 'disabled')
    }
    this.announce(serverId)
    return this.server(serverId)
  }

  async deleteServer(serverId: string): Promise<void> {
    this.oauth.cancel(serverId)
    await this.store.delete(serverId)
    await this.manager.remove(serverId)
    await this.refreshSecrets()
    this.deps.emit({ type: 'mcp.server.deleted', payload: { serverId } })
  }

  /** Reconnects, lists the tools and refreshes the cached list (a disabled server is only tried). */
  async testServer(serverId: string): Promise<McpTestResult> {
    const config = await this.requireConfig(serverId)
    const started = this.deps.now()
    if (!config.enabled) return this.testConfig(config)
    await this.manager.reset(serverId)
    try {
      await this.manager.listTools(serverId, { refresh: true })
      return {
        ok: true,
        tools: this.store.tools(serverId),
        error: null,
        latencyMs: this.deps.now() - started,
      }
    } catch (err) {
      return {
        ok: false,
        tools: [],
        error: this.redact(errorMessage(err)),
        latencyMs: null,
        ...(isAuthRequired(err) ? { authRequired: true } : {}),
      }
    }
  }

  /** The authorization URL to open, or null when the stored sign-in could be refreshed. */
  async startSignIn(serverId: string): Promise<string | null> {
    return this.oauth.start(await this.requireConfig(serverId))
  }

  /** The outcome of the sign-in waiting for the browser, or null when none is. */
  signInOutcome(serverId: string): Promise<McpSignInOutcome> | null {
    return this.oauth.pending(serverId)
  }

  handlers(): EndpointHandlers<keyof typeof mcpEndpoints> {
    return {
      listMcpServers: () => this.listServers(),
      createMcpServer: ({ body }) => this.createServer(body),
      testMcpDraft: async ({ body }) => {
        if (body.serverId) this.requireServer(body.serverId)
        return this.testConfig(await this.store.draftConfig(body.config, body.serverId))
      },
      updateMcpServer: ({ params, body }) => this.updateServer(params.serverId, body),
      deleteMcpServer: async ({ params }) => {
        await this.deleteServer(params.serverId)
        return { ok: true as const }
      },
      testMcpServer: ({ params }) => this.testServer(params.serverId),
      listMcpTools: async ({ params, query }) => {
        this.requireServer(params.serverId)
        if (query.refresh) await this.manager.listTools(params.serverId, { refresh: true })
        return this.store.tools(params.serverId)
      },
      listBotMcpServers: ({ params }) => {
        this.requireBot(params.botId)
        return this.store.botServers(params.botId)
      },
      updateBotMcpServer: ({ params, body }) => {
        this.requireBot(params.botId)
        return this.store.updateBotServer(params.botId, params.serverId, body)
      },
      startMcpOAuth: async ({ params }) => {
        const authorizationUrl = await this.startSignIn(params.serverId)
        return { authorizationUrl, server: this.server(params.serverId) }
      },
      cancelMcpOAuth: ({ params }) => {
        this.requireServer(params.serverId)
        this.oauth.cancel(params.serverId)
        return this.server(params.serverId)
      },
      disconnectMcpOAuth: async ({ params }) => {
        this.requireServer(params.serverId)
        await this.oauth.disconnect(params.serverId)
        await this.manager.reset(params.serverId, 'needs_auth')
        this.announce(params.serverId)
        return this.server(params.serverId)
      },
    }
  }

  private requireBot(botId: string): Bot {
    const bot = this.deps.getBot(botId)
    if (!bot) throw notFound('bot', botId)
    return bot
  }

  private requireServer(serverId: string): void {
    if (!this.store.exists(serverId)) throw notFound('MCP server', serverId)
  }

  private async requireConfig(serverId: string): Promise<McpServerConfig> {
    const config = await this.store.config(serverId)
    if (!config) throw notFound('MCP server', serverId)
    return config
  }

  private checkBots(allowed: McpServer['allowedBots'] | undefined): void {
    if (!allowed || allowed === 'all') return
    for (const id of allowed) this.requireBot(id)
  }
}
