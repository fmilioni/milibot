import { type CliMcpConfig, cliMcpServers } from '../cli/mcp-config'
import { normalizeMcpToolName } from '../mcp/names'
import type { BotMcpServerView, McpOAuthProxyEndpoint } from '../mcp/tools'

/** External servers of a Claude Code bot: `mcpServers` entries of `--mcp-config` and `--disallowedTools`. */
export function claudeCodeMcpConfig(
  views: BotMcpServerView[],
  guestHostAddress: string,
  oauthProxy?: McpOAuthProxyEndpoint,
): CliMcpConfig {
  const { servers, fingerprint, tokensByServer } = cliMcpServers(views, guestHostAddress, oauthProxy)
  return {
    servers: Object.fromEntries(servers.map((s) => [s.slug, { ...s.endpoint }])),
    disallowedTools: servers.flatMap((s) =>
      s.disabledTools.map((tool) => `mcp__${s.slug}__${normalizeMcpToolName(tool)}`),
    ),
    fingerprint,
    tokensByServer,
  }
}
