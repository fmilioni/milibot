export function startOAuthMcpServer(options?: { accessTtlSec?: number; account?: string }): Promise<{
  url: string
  stats: {
    registrations: number
    authorizations: number
    exchanges: number
    refreshes: number
    mcpRequests: number
    redirectUris: string[]
  }
  expireAccessTokens(): void
  revokeRefreshTokens(): void
  close(): Promise<void>
}>
