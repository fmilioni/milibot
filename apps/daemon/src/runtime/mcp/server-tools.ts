import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  flagArg,
  optionalString,
  requireString,
  stringListArg,
  textArg,
  type ToolArgs,
  ToolInputError,
  toolText,
} from '@milibot/agent/tools'
import { type Bot, type BotScope, type McpServer, type McpTransport, secretRefRegex } from '@milibot/shared'

import { DaemonError } from '../../errors'
import { resolveByRef, type ToolHandlers, ToolSwitch } from '../tools-core'
import type { McpAdmin, McpCardDetails, ProposedChanges, ProposedKeyValue, ProposedServer } from './admin'
import type { McpStore } from './store'
import { listText } from './texts'

/** Names of headers and variables that carry credentials: their values must come by reference. */
const SECRET_NAME = /auth|token|secret|key|pass(word|wd)?|pwd|cookie|credential|session|bearer|signature/i
/** Shorter known values are too likely to appear by chance in a plain value. */
const MIN_KNOWN_SECRET = 8

export interface McpServerToolsDeps {
  admin: Pick<McpAdmin, 'list' | 'propose' | 'test' | 'connect'>
  store: Pick<McpStore, 'validate'>
  listBots: () => Bot[]
  /** Names of the secrets the bot can use by reference. */
  secretNames: (bot: Bot) => string[]
  /** Every secret value the workspace holds (plain values must not carry one). */
  secretValues: () => string[]
}

const refNames = (value: string): string[] => [...value.matchAll(secretRefRegex())].map((m) => m[1] as string)

/** `mcp_server_*`: the bot manages the workspace's MCP servers, every change confirmed by the user. */
export class McpServerTools extends ToolSwitch {
  readonly name = 'MCP servers'
  protected readonly handlers: ToolHandlers = {
    mcp_server_list: (ctx) => toolText(listText(this.deps.admin.list(), this.deps.listBots(), ctx.bot)),
    mcp_server_add: (ctx, a) => this.add(ctx, a),
    mcp_server_update: (ctx, a) => this.update(ctx, a),
    mcp_server_remove: async (ctx, a) => {
      const server = this.server(a)
      return toolText(
        await this.deps.admin.propose(
          ctx,
          { kind: 'remove', serverId: server.id },
          { serverName: server.name, details: this.target(server), reason: this.reason(a) },
        ),
      )
    },
    mcp_server_test: async (_ctx, a) => toolText(await this.deps.admin.test(this.server(a).id)),
    mcp_server_connect: async (ctx, a) => {
      const server = this.server(a)
      if (server.transport !== 'http')
        throw new ToolInputError(`${server.name} runs in the VM: only remote servers sign in`)
      return toolText(await this.deps.admin.connect(ctx, server.id))
    },
  }

  constructor(private readonly deps: McpServerToolsDeps) {
    super()
  }

  private server(a: ToolArgs): McpServer {
    const ref = requireString(a, 'server')
    const servers = this.deps.admin.list()
    const match = resolveByRef(servers, ref, {
      id: (s) => s.id,
      names: (s) => [s.name, s.slug],
      ambiguous: { exact: 'first', partial: 'report' },
    })
    if ('found' in match) return match.found
    if ('ambiguous' in match)
      throw new ToolInputError(
        `"${ref}" matches ${match.ambiguous.map((s) => s.name).join(', ')}; be precise`,
      )
    throw new DaemonError('not_found', `No MCP server named "${ref}". Use mcp_server_list to see them.`)
  }

  private reason(a: ToolArgs): string {
    return optionalString(a, 'reason')?.slice(0, 300) ?? ''
  }

  private target(server: Pick<McpServer, 'transport' | 'url' | 'command' | 'args'>): McpCardDetails {
    return {
      transport: server.transport,
      target:
        server.transport === 'http' ? (server.url ?? '') : [server.command ?? '', ...server.args].join(' '),
    }
  }

  private connection(
    a: ToolArgs,
    required: boolean,
  ): { transport: McpTransport; url: string | null; command: string | null } | null {
    const url = optionalString(a, 'url')?.trim() || null
    const command = optionalString(a, 'command')?.trim() || null
    if (url && command)
      throw new ToolInputError('Give either "url" (remote) or "command" (run in the VM), not both')
    if (!url && !command) {
      if (required)
        throw new ToolInputError('Give "url" for a remote server or "command" for one run in the VM')
      return null
    }
    return url ? { transport: 'http', url, command: null } : { transport: 'stdio_vm', url: null, command }
  }

  private args(a: ToolArgs): string[] | undefined {
    if (a.args === undefined) return undefined
    if (!Array.isArray(a.args) || a.args.some((v) => typeof v !== 'string'))
      throw new ToolInputError('"args" must be a list of strings')
    return a.args as string[]
  }

  /** `[{name, value}]` (or `{NAME: value}`); every value checked so that no secret comes as plain text. */
  private keyValues(ctx: ToolExecContext, a: ToolArgs, key: 'headers' | 'env', valueRequired: boolean) {
    const raw = a[key]
    if (raw === undefined || raw === null) return undefined
    const items: unknown[] = Array.isArray(raw)
      ? raw
      : typeof raw === 'object'
        ? Object.entries(raw).map(([name, value]) => ({ name, value }))
        : []
    if (!Array.isArray(raw) && typeof raw !== 'object')
      throw new ToolInputError(`"${key}" must be a list of {name, value}`)
    const available = new Set(this.deps.secretNames(ctx.bot))
    const known = this.deps.secretValues().filter((v) => v.length >= MIN_KNOWN_SECRET)
    return items.map((item): ProposedKeyValue => {
      const entry = (item && typeof item === 'object' ? item : {}) as ToolArgs
      const name = textArg(entry, 'name')
      if (!name) throw new ToolInputError(`Every entry of "${key}" needs a "name"`)
      const value = typeof entry.value === 'string' ? entry.value : undefined
      if (value === undefined) {
        if (valueRequired) throw new ToolInputError(`${name} needs a "value"`)
        return { name }
      }
      const refs = refNames(value)
      const missing = refs.filter((ref) => !available.has(ref))
      if (missing.length)
        throw new ToolInputError(
          `${missing.map((n) => `{{secret:${n}}}`).join(', ')} is not available to you: ask the user for it with ` +
            'request_secret first (check the names with list_secrets).',
        )
      if (!refs.length && (SECRET_NAME.test(name) || known.some((secret) => value.includes(secret))))
        throw new ToolInputError(
          `${name} looks like a credential: never pass it as text. Get it with request_secret and pass ` +
            '{{secret:NAME}} as the value (e.g. "Bearer {{secret:NAME}}").',
        )
      return { name, value }
    })
  }

  private bots(ctx: ToolExecContext, a: ToolArgs): BotScope | undefined {
    if (a.bots === undefined) return undefined
    const refs = stringListArg(a, 'bots')
    if (refs.some((ref) => /^(all|everyone)$/i.test(ref))) return 'all'
    const bots = this.deps.listBots()
    const ids = refs.map((ref) => {
      const match = resolveByRef(bots, ref, {
        id: (b) => b.id,
        names: (b) => [b.name, b.slug],
        ambiguous: { exact: 'first', partial: 'report' },
      })
      if ('found' in match) return match.found.id
      throw new ToolInputError(`No single bot matches "${ref}"`)
    })
    return ids.length ? [...new Set(ids)] : [ctx.bot.id]
  }

  private botNames(scope: BotScope): string[] | 'all' {
    if (scope === 'all') return 'all'
    const bots = this.deps.listBots()
    return scope.map((id) => bots.find((b) => b.id === id)?.name ?? id)
  }

  private check(server: Omit<ProposedServer, 'name' | 'allowedBots' | 'args'>): void {
    const kv = (items: ProposedKeyValue[]) =>
      items.map((i) => ({ name: i.name, value: i.value ?? null, secret: false }))
    try {
      this.deps.store.validate({
        transport: server.transport,
        command: server.command,
        url: server.url,
        headers: kv(server.headers),
        env: kv(server.env),
      })
    } catch (err) {
      if (err instanceof TypeError) throw new ToolInputError('"url" is not a valid URL')
      throw err
    }
  }

  private async add(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const name = textArg(a, 'name')
    if (!name || name.length > 64) throw new ToolInputError('"name" is required (max 64 characters)')
    const connection = this.connection(a, true) as NonNullable<ReturnType<McpServerTools['connection']>>
    const remote = connection.transport === 'http'
    const headers = this.keyValues(ctx, a, 'headers', true) ?? []
    const env = this.keyValues(ctx, a, 'env', true) ?? []
    if (remote ? env.length : headers.length)
      throw new ToolInputError(
        remote ? 'A remote server takes "headers", not "env"' : 'A command takes "env", not "headers"',
      )
    const server: ProposedServer = {
      name,
      ...connection,
      args: remote ? [] : (this.args(a) ?? []),
      headers,
      env,
      allowedBots: this.bots(ctx, a) ?? [ctx.bot.id],
    }
    this.check(server)
    const details: McpCardDetails = {
      ...this.target(server),
      ...(headers.length ? { headers } : {}),
      ...(env.length ? { env } : {}),
      bots: this.botNames(server.allowedBots),
    }
    return toolText(
      await this.deps.admin.propose(
        ctx,
        { kind: 'add', server },
        { serverName: name, details, reason: this.reason(a) },
      ),
    )
  }

  private async update(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const current = this.server(a)
    const name = optionalString(a, 'name')?.trim()
    if (name !== undefined && (!name || name.length > 64))
      throw new ToolInputError('"name" must have 1 to 64 characters')
    const connection = this.connection(a, false)
    const transport = connection?.transport ?? current.transport
    const args = this.args(a)
    const headers = this.keyValues(ctx, a, 'headers', false)
    const env = this.keyValues(ctx, a, 'env', false)
    if (transport === 'http' ? env?.length : headers?.length)
      throw new ToolInputError(
        transport === 'http'
          ? 'A remote server takes "headers", not "env"'
          : 'A command takes "env", not "headers"',
      )
    const allowedBots = this.bots(ctx, a)
    const enabled = flagArg(a, 'enabled')
    const changes: ProposedChanges = {
      ...(name !== undefined && name !== current.name ? { name } : {}),
      ...(connection ?? {}),
      ...(args !== undefined ? { args } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(allowedBots !== undefined ? { allowedBots } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    }
    if (Object.keys(changes).length === 0) throw new ToolInputError('Nothing to change')
    const merged = {
      transport,
      url: transport === 'http' ? (connection?.url ?? current.url) : null,
      command: transport === 'stdio_vm' ? (connection?.command ?? current.command) : null,
      args: changes.args ?? current.args,
    }
    const keepNames = (items: ProposedKeyValue[] | undefined, stored: McpServer['headers']) =>
      items ?? stored.map((s) => ({ name: s.name, value: s.value ?? '' }))
    this.check({
      ...merged,
      headers: transport === 'http' ? keepNames(headers, current.headers) : [],
      env: transport === 'stdio_vm' ? keepNames(env, current.env) : [],
    })
    const details: McpCardDetails = {
      ...(changes.name ? { name: changes.name } : {}),
      ...(connection || args ? this.target(merged) : {}),
      ...(headers ? { headers } : {}),
      ...(env ? { env } : {}),
      ...(allowedBots ? { bots: this.botNames(allowedBots) } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    }
    return toolText(
      await this.deps.admin.propose(
        ctx,
        { kind: 'update', serverId: current.id, changes },
        { serverName: current.name, details, reason: this.reason(a) },
      ),
    )
  }
}
