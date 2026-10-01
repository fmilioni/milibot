import { createHash } from 'node:crypto'

import { type BotMcpServerView, type McpOAuthProxyEndpoint, mcpToolTokens, urlForGuest } from '../mcp/tools'

/** A bot's external MCP servers in a CLI engine's config shape. */
export interface CliMcpConfig {
  /** Config entries by server slug (secrets included: they only reach the process through a 0600 file or stdin). */
  servers: Record<string, Record<string, unknown>>
  /** Tool names the engine is told to refuse (the tools the bot switched off), when it takes such a list. */
  disallowedTools: string[]
  /** Hash of the configuration without secret values (part of the session profile). */
  fingerprint: string
  /** Estimated tokens of the enabled tools, by server name (context composition). */
  tokensByServer: Record<string, number>
}

/** How the engine reaches one server from the VM. */
type CliMcpEndpoint =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

export interface CliMcpServer {
  slug: string
  endpoint: CliMcpEndpoint
  /** Raw MCP names of the tools the bot switched off, sorted. */
  disabledTools: string[]
}

/**
 * The servers a CLI engine gets, sorted by slug. The engine runs inside the VM, so stdio servers go as they
 * are (it starts them itself, as `agent`) and HTTP servers keep their URL and headers. OAuth servers can't use
 * Milibot's tokens inside the engine's own client: they go through the daemon's proxy, which calls them with
 * its signed-in client.
 */
export function cliMcpServers(
  views: BotMcpServerView[],
  guestHostAddress: string,
  oauthProxy?: McpOAuthProxyEndpoint,
): Pick<CliMcpConfig, 'fingerprint' | 'tokensByServer'> & { servers: CliMcpServer[] } {
  const servers: CliMcpServer[] = []
  const tokensByServer: Record<string, number> = {}
  const fingerprint: unknown[] = []
  for (const server of [...views].sort((a, b) => a.config.slug.localeCompare(b.config.slug))) {
    const { config } = server
    let endpoint: CliMcpEndpoint
    if (config.transport === 'stdio_vm') {
      if (!config.command) continue
      endpoint = {
        type: 'stdio',
        command: config.command,
        args: config.args,
        ...(Object.keys(config.env).length ? { env: config.env } : {}),
      }
    } else if (config.oauth) {
      if (!oauthProxy) continue
      endpoint = {
        type: 'http',
        url: oauthProxy.url(config.slug),
        headers: { Authorization: `Bearer ${oauthProxy.token}` },
      }
    } else {
      if (!config.url) continue
      endpoint = {
        type: server.httpKind === 'sse' ? 'sse' : 'http',
        url: urlForGuest(config.url, guestHostAddress),
        ...(Object.keys(config.headers).length ? { headers: config.headers } : {}),
      }
    }
    const off = [...server.disabledTools].sort()
    servers.push({ slug: config.slug, endpoint, disabledTools: off })
    const tokens = server.tools
      .filter((t) => !server.disabledTools.has(t.name))
      .reduce((sum, t) => sum + mcpToolTokens(config.slug, t), 0)
    if (tokens > 0) tokensByServer[config.name] = tokens
    fingerprint.push([
      config.slug,
      config.transport,
      config.command,
      config.args,
      config.url,
      Object.keys(config.env).sort(),
      Object.keys(config.headers).sort(),
      server.httpKind,
      server.revision,
      off,
      ...(config.oauth ? ['oauth-proxy'] : []),
    ])
  }
  return {
    servers,
    fingerprint: fingerprint.length
      ? createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 12)
      : '',
    tokensByServer,
  }
}
