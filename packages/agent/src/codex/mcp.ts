import { type CliMcpConfig, cliMcpServers } from '../cli/mcp-config'
import type { BotMcpServerView, McpOAuthProxyEndpoint } from '../mcp/tools'

/**
 * External servers of a Codex bot as `mcp_servers.<slug>` entries of its thread config. Like Milibot's own
 * server, their tools never wait for an approval and are offered upfront instead of through "code mode".
 */
export function codexMcpConfig(
  views: BotMcpServerView[],
  guestHostAddress: string,
  oauthProxy?: McpOAuthProxyEndpoint,
): CliMcpConfig {
  const { servers, fingerprint, tokensByServer } = cliMcpServers(views, guestHostAddress, oauthProxy)
  const entries: Record<string, Record<string, unknown>> = {}
  for (const { slug, endpoint, disabledTools } of servers) {
    entries[slug] = {
      ...(endpoint.type === 'stdio'
        ? { command: endpoint.command, args: endpoint.args, ...(endpoint.env ? { env: endpoint.env } : {}) }
        : { url: endpoint.url, ...(endpoint.headers ? { http_headers: endpoint.headers } : {}) }),
      default_tools_approval_mode: 'approve',
      omit_tools_from: ['code_mode'],
      ...(disabledTools.length ? { disabled_tools: disabledTools } : {}),
    }
  }
  return { servers: entries, disallowedTools: [], fingerprint, tokensByServer }
}
