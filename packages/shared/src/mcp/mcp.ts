import { z } from 'zod'

import { BotScope } from '../bots/bots'
import { endpoint, Ok, queryBool } from '../http/endpoint'

/** `stdio_vm`: command run inside the workspace VM as `agent`; `http`: remote server (streamable HTTP or SSE). */
export const McpTransport = z.enum(['stdio_vm', 'http'])
export type McpTransport = z.infer<typeof McpTransport>

/**
 * Environment variable (stdio) or HTTP header. Secret values live in the secret store and are never
 * returned: `value` is null and `hasValue` tells whether one is stored.
 */
export const McpKeyValue = z.object({
  name: z.string(),
  value: z.string().nullable(),
  secret: z.boolean(),
  hasValue: z.boolean(),
})
export type McpKeyValue = z.infer<typeof McpKeyValue>

/** In a create/update body, a secret entry without `value` keeps the stored one. */
export const McpKeyValueInput = z.object({
  name: z.string().trim().min(1).max(128),
  value: z.string().max(16_384).nullable().optional(),
  secret: z.boolean().default(false),
})
export type McpKeyValueInput = z.infer<typeof McpKeyValueInput>

export const McpTool = z.object({
  name: z.string(),
  description: z.string(),
  /** Of the tool definition in the model's context. */
  tokens: z.number().int(),
})
export type McpTool = z.infer<typeof McpTool>

/** `needs_auth`: an OAuth server without valid tokens. */
export const McpConnectionStatus = z.enum([
  'idle',
  'connecting',
  'connected',
  'error',
  'disabled',
  'needs_auth',
])
export type McpConnectionStatus = z.infer<typeof McpConnectionStatus>

export const McpServerState = z.object({
  status: McpConnectionStatus,
  error: z.string().nullable(),
  since: z.number().int(),
})
export type McpServerState = z.infer<typeof McpServerState>

/** Tokens live in the secret store and are refreshed automatically. */
export const McpServerOAuth = z.object({
  /** Tokens are stored (they may still be refused: then the state is `needs_auth`). */
  connected: z.boolean(),
  /** Who signed in, when the server says (ID token or userinfo); null: unknown. */
  account: z.string().nullable(),
  connectedAt: z.number().int().nullable(),
  /** Waiting for the browser's redirect back. */
  authorizing: z.boolean(),
})
export type McpServerOAuth = z.infer<typeof McpServerOAuth>

export const McpServer = z.object({
  id: z.string(),
  /** Stable key used in tool names (`mcp__<slug>__<tool>`); never changes after creation. */
  slug: z.string(),
  name: z.string(),
  transport: McpTransport,
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  env: z.array(McpKeyValue),
  headers: z.array(McpKeyValue),
  enabled: z.boolean(),
  allowedBots: BotScope,
  /** Last tool list seen (test or connection); empty until the first successful connection. */
  tools: z.array(McpTool),
  toolsUpdatedAt: z.number().int().nullable(),
  state: McpServerState,
  /** null: no OAuth (or not detected yet). */
  oauth: McpServerOAuth.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type McpServer = z.infer<typeof McpServer>

const McpServerFields = {
  name: z.string().trim().min(1).max(64),
  transport: McpTransport,
  command: z.string().trim().max(1024).nullable().optional(),
  args: z.array(z.string().max(4096)).max(64).optional(),
  url: z.string().trim().url().max(2048).nullable().optional(),
  env: z.array(McpKeyValueInput).max(64).optional(),
  headers: z.array(McpKeyValueInput).max(64).optional(),
  enabled: z.boolean().optional(),
  allowedBots: BotScope.optional(),
}

export const CreateMcpServerBody = z.object(McpServerFields)
export type CreateMcpServerBody = z.input<typeof CreateMcpServerBody>

export const UpdateMcpServerBody = z.object(McpServerFields).partial()
export type UpdateMcpServerBody = z.input<typeof UpdateMcpServerBody>

/** Tests a configuration before saving; `serverId` supplies the stored secrets of an edited server. */
const TestMcpDraftBody = z.object({
  serverId: z.string().optional(),
  config: CreateMcpServerBody,
})

export const McpTestResult = z.object({
  ok: z.boolean(),
  tools: z.array(McpTool),
  error: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  /** The server asks for an OAuth sign-in (save it, then connect). */
  authRequired: z.boolean().optional(),
})
export type McpTestResult = z.infer<typeof McpTestResult>

export const McpOAuthStart = z.object({
  /** Open it in the browser; null when the stored sign-in could be refreshed without the user. */
  authorizationUrl: z.string().nullable(),
  server: McpServer,
})
export type McpOAuthStart = z.infer<typeof McpOAuthStart>

const McpToolsQuery = z.object({
  refresh: queryBool(false),
})

/** A server a bot is allowed to use, with the bot's own switches. */
export const BotMcpServer = z.object({
  serverId: z.string(),
  enabled: z.boolean(),
  /** Raw MCP tool names. */
  disabledTools: z.array(z.string()),
})
export type BotMcpServer = z.infer<typeof BotMcpServer>

export const UpdateBotMcpServerBody = z.object({
  enabled: z.boolean().optional(),
  disabledTools: z.array(z.string().max(256)).max(2000).optional(),
})
export type UpdateBotMcpServerBody = z.input<typeof UpdateBotMcpServerBody>

export const mcpEndpoints = {
  listMcpServers: endpoint({ method: 'GET', path: '/w/:workspaceId/mcp', response: z.array(McpServer) }),
  createMcpServer: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/mcp',
    body: CreateMcpServerBody,
    response: McpServer,
  }),
  /** Tests an unsaved configuration. */
  testMcpDraft: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/mcp/test',
    body: TestMcpDraftBody,
    response: McpTestResult,
  }),
  updateMcpServer: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/mcp/:serverId',
    body: UpdateMcpServerBody,
    response: McpServer,
  }),
  deleteMcpServer: endpoint({ method: 'DELETE', path: '/w/:workspaceId/mcp/:serverId', response: Ok }),
  /** Reconnects, lists the tools and refreshes the cached list. */
  testMcpServer: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/mcp/:serverId/test',
    response: McpTestResult,
  }),
  /** A loopback redirect catches the browser's answer. */
  startMcpOAuth: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/mcp/:serverId/oauth/start',
    response: McpOAuthStart,
  }),
  cancelMcpOAuth: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/mcp/:serverId/oauth/cancel',
    response: McpServer,
  }),
  /** Forgets the tokens; the server then waits for a new sign-in. */
  disconnectMcpOAuth: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/mcp/:serverId/oauth/disconnect',
    response: McpServer,
  }),
  listMcpTools: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/mcp/:serverId/tools',
    query: McpToolsQuery,
    response: z.array(McpTool),
  }),
  listBotMcpServers: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/bots/:botId/mcp',
    response: z.array(BotMcpServer),
  }),
  updateBotMcpServer: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/bots/:botId/mcp/:serverId',
    body: UpdateBotMcpServerBody,
    response: BotMcpServer,
  }),
}
