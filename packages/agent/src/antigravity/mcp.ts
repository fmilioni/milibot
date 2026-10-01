import { type CliMcpConfig, cliMcpServers } from '../cli/mcp-config'
import type { ToolDefinition } from '../llm/provider'
import type { BotMcpServerView, McpOAuthProxyEndpoint } from '../mcp/tools'

/**
 * External servers of an Antigravity bot as entries of its MCP bridge config (`{type, command|url, …}`). `agy`
 * reads one global MCP config, so every server of a lane goes through Milibot's bridge, which hides the tools
 * the bot switched off (`disabledTools`). `tools` carries the enabled tools' schemas for the lane's prompt.
 */
export function antigravityMcpConfig(
  views: BotMcpServerView[],
  guestHostAddress: string,
  oauthProxy?: McpOAuthProxyEndpoint,
): CliMcpConfig {
  const { servers, fingerprint, tokensByServer } = cliMcpServers(views, guestHostAddress, oauthProxy)
  const toolsOf = (slug: string): ToolDefinition[] => {
    const view = views.find((v) => v.config.slug === slug)
    return (view?.tools ?? [])
      .filter((t) => !view?.disabledTools.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }
  return {
    servers: Object.fromEntries(
      servers.map((s) => [
        s.slug,
        {
          ...s.endpoint,
          ...(s.disabledTools.length ? { disabledTools: s.disabledTools } : {}),
          tools: toolsOf(s.slug),
        },
      ]),
    ),
    disallowedTools: [],
    fingerprint,
    tokensByServer,
  }
}
