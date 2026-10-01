import { estimateTokens } from '@milibot/shared'

import type { ToolDefinition } from '../llm/provider'
import { cleanToolSchema } from '../llm/tool-schema'
import type { McpHttpKind, McpServerConfig, McpToolInfo } from './config'
import { mcpToolName } from './names'

const MAX_DESCRIPTION = 2000

/** An external server as one bot sees it: allowed, switched on, with its cached tools. */
export interface BotMcpServerView {
  config: McpServerConfig
  tools: McpToolInfo[]
  /** Raw MCP tool names this bot switched off. */
  disabledTools: ReadonlySet<string>
  httpKind: McpHttpKind | null
  /** Changes whenever the stored configuration (secrets included) changes. */
  revision: number
}

interface McpToolRef {
  serverId: string
  serverName: string
  tool: string
}

export interface BotMcpToolSet {
  tools: ToolDefinition[]
  /** Namespaced tool name → server and raw tool name. */
  index: Map<string, McpToolRef>
  /** Estimated tokens of the tool definitions, by server name. */
  tokensByServer: Record<string, number>
}

/** Tool definition as an API provider sees it (namespaced name, cleaned schema). */
function mcpToolDefinition(serverSlug: string, tool: McpToolInfo): ToolDefinition {
  const description = tool.description.trim()
  return {
    name: mcpToolName(serverSlug, tool.name),
    description:
      description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
    inputSchema: cleanToolSchema(tool.inputSchema, 'anthropic'),
  }
}

export function mcpToolTokens(serverSlug: string, tool: McpToolInfo): number {
  return estimateTokens(JSON.stringify(mcpToolDefinition(serverSlug, tool)))
}

/** The external tools a bot gets on an API provider: only its enabled servers and tools. */
export function botMcpToolSet(
  servers: Array<
    Omit<BotMcpServerView, 'config'> & { config: Pick<McpServerConfig, 'id' | 'slug' | 'name'> }
  >,
): BotMcpToolSet {
  const tools: ToolDefinition[] = []
  const index = new Map<string, McpToolRef>()
  const tokensByServer: Record<string, number> = {}
  for (const server of servers) {
    let tokens = 0
    for (const tool of server.tools) {
      if (server.disabledTools.has(tool.name)) continue
      const definition = mcpToolDefinition(server.config.slug, tool)
      if (index.has(definition.name)) continue
      index.set(definition.name, {
        serverId: server.config.id,
        serverName: server.config.name,
        tool: tool.name,
      })
      tools.push(definition)
      tokens += estimateTokens(JSON.stringify(definition))
    }
    if (tokens > 0) tokensByServer[server.config.name] = (tokensByServer[server.config.name] ?? 0) + tokens
  }
  return { tools, index, tokensByServer }
}

/** Host-only names (`localhost`) point to the host from the VM through QEMU's gateway. */
export function urlForGuest(url: string, hostAddress: string): string {
  try {
    const parsed = new URL(url)
    if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
      parsed.hostname = hostAddress
      return parsed.toString()
    }
  } catch {
    return url
  }
  return url
}

/** Where a CLI engine (Claude Code, Codex) reaches the daemon's proxy of an OAuth server (as seen from the VM). */
export interface McpOAuthProxyEndpoint {
  url(slug: string): string
  /** The bot's bearer token for the daemon's MCP server. */
  token: string
}
