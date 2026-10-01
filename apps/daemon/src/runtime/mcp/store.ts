import {
  type McpHttpKind,
  type McpServerConfig,
  mcpServerSlug,
  type McpToolInfo,
  mcpToolTokens,
  RESERVED_MCP_SLUGS,
} from '@milibot/agent'
import {
  type BotMcpServer,
  type BotScope,
  type CreateMcpServerBody,
  type McpKeyValue,
  type McpKeyValueInput,
  type McpServer,
  type McpServerState,
  type McpTool,
  type McpTransport,
  newId,
  type UpdateBotMcpServerBody,
  type UpdateMcpServerBody,
} from '@milibot/shared'

import { bool, type Db, parseJson } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'
import type { Parsed } from '../../handlers'
import type { SecretStore } from '../../secrets/secret-store'

interface ServerRow {
  id: string
  slug: string
  name: string
  transport: McpTransport
  command: string | null
  args: string
  url: string | null
  env: string
  headers: string
  enabled: number
  allowed_bots: string
  tools: string
  tools_updated_at: number | null
  http_kind: McpHttpKind | null
  revision: number
  created_at: number
  updated_at: number
}

interface StoredKeyValue {
  name: string
  /** Null for secrets (the value is in the SecretStore). */
  value: string | null
  secret: boolean
}

interface PrefRow {
  bot_id: string
  server_id: string
  enabled: number
  disabled_tools: string
}

type Section = 'env' | 'header'

const mcpSecretKey = (serverId: string, section: Section, name: string) =>
  `mcp.${serverId}.${section}.${name}`

/** Secret store entry with the OAuth client, tokens and discovery of a server. */
const mcpOAuthSecretKey = (serverId: string) => `mcp.${serverId}.oauth`
/** Workspace setting with what the UI may see of an OAuth sign-in (its presence marks the server as OAuth). */
const oauthSettingKey = (serverId: string) => `mcp.oauth.${serverId}`

export interface McpOAuthInfo {
  hasTokens: boolean
  account: string | null
  connectedAt: number | null
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** A stored server with its cached tools (full schemas, for the tool set of a turn). */
export interface StoredMcpServer {
  id: string
  slug: string
  name: string
  enabled: boolean
  allowedBots: BotScope
  tools: McpToolInfo[]
  httpKind: McpHttpKind | null
  revision: number
}

/** `mcp_servers` + `bot_mcp_prefs`; secret values go to the SecretStore and never come back out of the API. */
export class McpStore {
  /**
   * Secret store reads are slow (a CLI or an OS keyring round trip): values are cached for the life of the
   * runtime.
   */
  private readonly secretCache = new Map<string, string | null>()

  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly secrets: SecretStore,
    private readonly now: () => number,
  ) {}

  private async getSecret(key: string): Promise<string | null> {
    if (this.secretCache.has(key)) return this.secretCache.get(key) ?? null
    const value = await this.secrets.get(this.workspaceId, key)
    this.secretCache.set(key, value)
    return value
  }

  private async setSecret(key: string, value: string): Promise<void> {
    await this.secrets.set(this.workspaceId, key, value)
    this.secretCache.set(key, value)
  }

  private async deleteSecret(key: string): Promise<void> {
    await this.secrets.delete(this.workspaceId, key)
    this.secretCache.set(key, null)
  }

  private row(id: string): ServerRow {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as ServerRow | undefined
    if (!row) throw notFound('MCP server', id)
    return row
  }

  private rows(): ServerRow[] {
    return this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as ServerRow[]
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM mcp_servers WHERE id = ?').get(id) !== undefined
  }

  private toServer(row: ServerRow, state: McpServerState): McpServer {
    const pairs = (json: string): McpKeyValue[] =>
      parseJson<StoredKeyValue[]>(json, []).map((kv) => ({
        name: kv.name,
        value: kv.secret ? null : kv.value,
        secret: kv.secret,
        hasValue: kv.secret ? true : kv.value !== null,
      }))
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: parseJson<string[]>(row.args, []),
      url: row.url,
      env: pairs(row.env),
      headers: pairs(row.headers),
      enabled: row.enabled === 1,
      allowedBots: parseJson<BotScope>(row.allowed_bots, 'all'),
      tools: parseJson<McpToolInfo[]>(row.tools, []).map((tool) => this.publicTool(row.slug, tool)),
      toolsUpdatedAt: row.tools_updated_at,
      state: row.enabled === 1 ? state : { ...state, status: 'disabled', error: null },
      oauth: this.oauthServer(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private publicTool(slug: string, tool: McpToolInfo): McpTool {
    return { name: tool.name, description: tool.description, tokens: mcpToolTokens(slug, tool) }
  }

  oauthInfo(id: string): McpOAuthInfo | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(oauthSettingKey(id)) as
      { value: string } | undefined
    return row ? parseJson<McpOAuthInfo | null>(row.value, null) : null
  }

  setOAuthInfo(id: string, info: McpOAuthInfo | null): void {
    if (!info) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(oauthSettingKey(id))
      return
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(oauthSettingKey(id), JSON.stringify(info), this.now())
  }

  private oauthServer(id: string): McpServer['oauth'] {
    const info = this.oauthInfo(id)
    return info
      ? {
          connected: info.hasTokens,
          account: info.account,
          connectedAt: info.connectedAt,
          authorizing: false,
        }
      : null
  }

  async getOAuthRecord(id: string): Promise<string | null> {
    return this.getSecret(mcpOAuthSecretKey(id))
  }

  async setOAuthRecord(id: string, record: string | null): Promise<void> {
    if (record === null) await this.deleteSecret(mcpOAuthSecretKey(id))
    else await this.setSecret(mcpOAuthSecretKey(id), record)
  }

  list(stateOf: (id: string) => McpServerState): McpServer[] {
    return this.rows().map((row) => this.toServer(row, stateOf(row.id)))
  }

  get(id: string, state: McpServerState): McpServer {
    return this.toServer(this.row(id), state)
  }

  stored(): StoredMcpServer[] {
    return this.rows().map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      enabled: row.enabled === 1,
      allowedBots: parseJson<BotScope>(row.allowed_bots, 'all'),
      tools: parseJson<McpToolInfo[]>(row.tools, []),
      httpKind: row.http_kind,
      revision: row.revision,
    }))
  }

  tools(id: string): McpTool[] {
    const row = this.row(id)
    return parseJson<McpToolInfo[]>(row.tools, []).map((tool) => this.publicTool(row.slug, tool))
  }

  private uniqueSlug(name: string): string {
    const base = mcpServerSlug(name)
    const taken = new Set(this.rows().map((r) => r.slug))
    let slug = base
    for (let i = 2; taken.has(slug) || RESERVED_MCP_SLUGS.has(slug); i++) slug = `${base}-${i}`
    return slug
  }

  private validate(input: {
    transport: McpTransport
    command: string | null
    url: string | null
    env: McpKeyValueInput[]
    headers: McpKeyValueInput[]
  }): void {
    if (input.transport === 'stdio_vm' && !input.command)
      throw new DaemonError('validation_failed', 'A command is required for a server in the VM')
    if (input.transport === 'http') {
      if (!input.url) throw new DaemonError('validation_failed', 'A URL is required for a remote server')
      const protocol = new URL(input.url).protocol
      if (protocol !== 'http:' && protocol !== 'https:')
        throw new DaemonError('validation_failed', 'The URL must start with http:// or https://')
    }
    const check = (items: McpKeyValueInput[], pattern: RegExp, what: string) => {
      const seen = new Set<string>()
      for (const item of items) {
        if (!pattern.test(item.name))
          throw new DaemonError('validation_failed', `Invalid ${what} name: ${item.name}`)
        const key = what === 'header' ? item.name.toLowerCase() : item.name
        if (seen.has(key)) throw new DaemonError('validation_failed', `Duplicate ${what}: ${item.name}`)
        seen.add(key)
      }
    }
    check(input.env, ENV_NAME, 'environment variable')
    check(input.headers, HEADER_NAME, 'header')
  }

  /**
   * Stores key/values: plain ones in the row, secret ones in the SecretStore. A secret sent without
   * a value keeps the stored one; secrets that disappeared (or became plain) are deleted.
   */
  private async saveSection(
    serverId: string,
    section: Section,
    items: McpKeyValueInput[],
    previous: StoredKeyValue[],
  ): Promise<StoredKeyValue[]> {
    const stored: StoredKeyValue[] = []
    for (const item of items) {
      const key = mcpSecretKey(serverId, section, item.name)
      if (item.secret) {
        if (typeof item.value === 'string' && item.value !== '') {
          await this.setSecret(key, item.value)
        } else {
          const had = previous.find((p) => p.name === item.name)
          const existing = had?.secret ? await this.getSecret(key) : (had?.value ?? null)
          if (existing === null) throw new DaemonError('validation_failed', `Missing value for ${item.name}`)
          if (!had?.secret) await this.setSecret(key, existing)
        }
        stored.push({ name: item.name, value: null, secret: true })
      } else {
        const had = previous.find((p) => p.name === item.name)
        const value =
          typeof item.value === 'string'
            ? item.value
            : had?.secret
              ? await this.getSecret(key)
              : (had?.value ?? '')
        stored.push({ name: item.name, value: value ?? '', secret: false })
      }
    }
    for (const old of previous) {
      if (old.secret && !stored.some((s) => s.name === old.name && s.secret))
        await this.deleteSecret(mcpSecretKey(serverId, section, old.name))
    }
    return stored
  }

  async create(body: Parsed<typeof CreateMcpServerBody>): Promise<string> {
    const input = {
      transport: body.transport,
      command: body.transport === 'stdio_vm' ? (body.command ?? null) : null,
      url: body.transport === 'http' ? (body.url ?? null) : null,
      env: body.transport === 'stdio_vm' ? (body.env ?? []) : [],
      headers: body.transport === 'http' ? (body.headers ?? []) : [],
    }
    this.validate(input)
    const id = newId('mcpServer')
    const env = await this.saveSection(id, 'env', input.env, [])
    const headers = await this.saveSection(id, 'header', input.headers, [])
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, slug, name, transport, command, args, url, env, headers, enabled,
           allowed_bots, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.uniqueSlug(body.name),
        body.name,
        input.transport,
        input.command,
        JSON.stringify(body.transport === 'stdio_vm' ? (body.args ?? []) : []),
        input.url,
        JSON.stringify(env),
        JSON.stringify(headers),
        bool(body.enabled ?? true),
        JSON.stringify(body.allowedBots ?? 'all'),
        now,
        now,
      )
    return id
  }

  /** Returns whether the connection settings changed (the server must reconnect). */
  async update(
    id: string,
    body: Parsed<typeof UpdateMcpServerBody>,
  ): Promise<{ connectionChanged: boolean }> {
    const row = this.row(id)
    const transport = body.transport ?? row.transport
    const previousEnv = parseJson<StoredKeyValue[]>(row.env, [])
    const previousHeaders = parseJson<StoredKeyValue[]>(row.headers, [])
    const keep = (items: StoredKeyValue[]): McpKeyValueInput[] =>
      items.map((i) => ({ name: i.name, value: i.secret ? null : i.value, secret: i.secret }))
    const input = {
      transport,
      command: transport === 'stdio_vm' ? (body.command !== undefined ? body.command : row.command) : null,
      url: transport === 'http' ? (body.url !== undefined ? body.url : row.url) : null,
      env: transport === 'stdio_vm' ? (body.env ?? keep(previousEnv)) : [],
      headers: transport === 'http' ? (body.headers ?? keep(previousHeaders)) : [],
    }
    this.validate(input)
    // Sections not sent keep their stored entries as they are (secrets are not even read).
    const transportChanged = transport !== row.transport
    const env =
      body.env !== undefined || transportChanged
        ? await this.saveSection(id, 'env', input.env, previousEnv)
        : previousEnv
    const headers =
      body.headers !== undefined || transportChanged
        ? await this.saveSection(id, 'header', input.headers, previousHeaders)
        : previousHeaders
    const args = transport === 'stdio_vm' ? (body.args ?? parseJson<string[]>(row.args, [])) : []
    const connectionChanged =
      transport !== row.transport ||
      input.command !== row.command ||
      input.url !== row.url ||
      JSON.stringify(args) !== row.args ||
      body.env !== undefined ||
      body.headers !== undefined ||
      (body.enabled !== undefined && bool(body.enabled) !== row.enabled)
    this.db
      .prepare(
        `UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, url = ?, env = ?, headers = ?,
           enabled = ?, allowed_bots = ?, revision = revision + ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        body.name ?? row.name,
        transport,
        input.command,
        JSON.stringify(args),
        input.url,
        JSON.stringify(env),
        JSON.stringify(headers),
        body.enabled === undefined ? row.enabled : bool(body.enabled),
        body.allowedBots === undefined ? row.allowed_bots : JSON.stringify(body.allowedBots),
        connectionChanged ? 1 : 0,
        this.now(),
        id,
      )
    return { connectionChanged }
  }

  async delete(id: string): Promise<void> {
    const row = this.row(id)
    for (const [section, json] of [
      ['env', row.env],
      ['header', row.headers],
    ] as const) {
      for (const kv of parseJson<StoredKeyValue[]>(json, [])) {
        if (kv.secret) await this.deleteSecret(mcpSecretKey(id, section, kv.name))
      }
    }
    if (this.oauthInfo(id)) await this.deleteSecret(mcpOAuthSecretKey(id))
    this.setOAuthInfo(id, null)
    this.db.prepare('DELETE FROM bot_mcp_prefs WHERE server_id = ?').run(id)
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
  }

  saveTools(id: string, tools: McpToolInfo[], httpKind: McpHttpKind | null): void {
    this.db
      .prepare('UPDATE mcp_servers SET tools = ?, tools_updated_at = ?, http_kind = ? WHERE id = ?')
      .run(JSON.stringify(tools), this.now(), httpKind, id)
  }

  /** Configuration with secret values resolved, for connecting (never sent to the UI). */
  async config(id: string): Promise<McpServerConfig | null> {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as ServerRow | undefined
    if (!row) return null
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: parseJson<string[]>(row.args, []),
      url: row.url,
      env: await this.resolve(row.id, 'env', parseJson<StoredKeyValue[]>(row.env, [])),
      headers: await this.resolve(row.id, 'header', parseJson<StoredKeyValue[]>(row.headers, [])),
      enabled: row.enabled === 1,
      oauth: row.transport === 'http' && this.oauthInfo(row.id) !== null,
    }
  }

  /** Configuration of an unsaved form; secrets without a value come from `serverId` when given. */
  async draftConfig(body: Parsed<typeof CreateMcpServerBody>, serverId?: string): Promise<McpServerConfig> {
    const input = {
      transport: body.transport,
      command: body.transport === 'stdio_vm' ? (body.command ?? null) : null,
      url: body.transport === 'http' ? (body.url ?? null) : null,
      env: body.transport === 'stdio_vm' ? (body.env ?? []) : [],
      headers: body.transport === 'http' ? (body.headers ?? []) : [],
    }
    this.validate(input)
    const saved = serverId ? await this.config(serverId) : null
    const fill = (items: McpKeyValueInput[], section: 'env' | 'headers'): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const item of items) {
        const value =
          typeof item.value === 'string' && item.value !== '' ? item.value : saved?.[section][item.name]
        if (value === undefined && item.secret)
          throw new DaemonError('validation_failed', `Missing value for ${item.name}`)
        out[item.name] = value ?? ''
      }
      return out
    }
    return {
      id: serverId ?? 'draft',
      slug: saved?.slug ?? mcpServerSlug(body.name),
      name: body.name,
      transport: input.transport,
      command: input.command,
      args: body.transport === 'stdio_vm' ? (body.args ?? []) : [],
      url: input.url,
      env: fill(input.env, 'env'),
      headers: fill(input.headers, 'headers'),
      enabled: true,
    }
  }

  private async resolve(
    serverId: string,
    section: Section,
    items: StoredKeyValue[],
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const item of items) {
      out[item.name] = item.secret
        ? ((await this.getSecret(mcpSecretKey(serverId, section, item.name))) ?? '')
        : (item.value ?? '')
    }
    return out
  }

  /** Every secret value of the workspace's servers (redaction of logged payloads). */
  async secretValues(): Promise<string[]> {
    const values: string[] = []
    for (const row of this.rows()) {
      for (const [section, json] of [
        ['env', row.env],
        ['header', row.headers],
      ] as const) {
        for (const kv of parseJson<StoredKeyValue[]>(json, [])) {
          if (!kv.secret) continue
          const value = await this.getSecret(mcpSecretKey(row.id, section, kv.name))
          if (value) values.push(value)
        }
      }
    }
    return values
  }

  private prefs(botId: string): Map<string, PrefRow> {
    const rows = this.db.prepare('SELECT * FROM bot_mcp_prefs WHERE bot_id = ?').all(botId) as PrefRow[]
    return new Map(rows.map((r) => [r.server_id, r]))
  }

  static allows(allowed: BotScope, botId: string): boolean {
    return allowed === 'all' || allowed.includes(botId)
  }

  /** Servers the bot is allowed to use, with its switches (whether the server is on or not). */
  botServers(botId: string): BotMcpServer[] {
    const prefs = this.prefs(botId)
    return this.stored()
      .filter((s) => McpStore.allows(s.allowedBots, botId))
      .map((s) => {
        const pref = prefs.get(s.id)
        return {
          serverId: s.id,
          enabled: pref ? pref.enabled === 1 : true,
          disabledTools: parseJson<string[]>(pref?.disabled_tools, []),
        }
      })
  }

  updateBotServer(botId: string, serverId: string, body: UpdateBotMcpServerBody): BotMcpServer {
    const server = this.stored().find((s) => s.id === serverId)
    if (!server) throw notFound('MCP server', serverId)
    if (!McpStore.allows(server.allowedBots, botId))
      throw new DaemonError('conflict', 'This bot is not allowed to use this server')
    const current = this.botServers(botId).find((s) => s.serverId === serverId) as BotMcpServer
    const next: BotMcpServer = {
      serverId,
      enabled: body.enabled ?? current.enabled,
      disabledTools: body.disabledTools ? [...new Set(body.disabledTools)].sort() : current.disabledTools,
    }
    this.db
      .prepare(
        `INSERT INTO bot_mcp_prefs (bot_id, server_id, enabled, disabled_tools, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, server_id) DO UPDATE SET enabled = excluded.enabled,
           disabled_tools = excluded.disabled_tools, updated_at = excluded.updated_at`,
      )
      .run(botId, serverId, bool(next.enabled), JSON.stringify(next.disabledTools), this.now())
    return next
  }
}
