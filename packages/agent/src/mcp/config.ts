import type { McpTransport } from '@milibot/shared'

/** A server's configuration with its secret values resolved (kept in memory only). */
export interface McpServerConfig {
  id: string
  slug: string
  name: string
  transport: McpTransport
  command: string | null
  args: string[]
  url: string | null
  env: Record<string, string>
  headers: Record<string, string>
  enabled: boolean
  /** Remote server that signs in with OAuth; its tokens come from `oauthProvider`. */
  oauth?: boolean
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** How an HTTP server answered: streamable HTTP or the older HTTP+SSE transport. */
export type McpHttpKind = 'streamable' | 'sse'
