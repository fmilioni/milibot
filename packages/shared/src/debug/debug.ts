import { z } from 'zod'

import { ActivityStepStatus } from '../chat/messages'
import { AuthorType } from '../core/schemas'
import { CostSource, LlmCallModelUsage, TokenBuckets } from '../costs/costs'
import { endpoint, queryBool } from '../http/endpoint'
import { StepDiff } from '../work/file-edits'

/** Estimated tokens per context section of one LLM call. */
export const ContextComposition = z.object({
  systemPrompt: z.number().int(),
  longTermMemory: z.number().int(),
  summaries: z.number().int(),
  retrieved: z.number().int(),
  recentTail: z.number().int(),
  tools: z.number().int(),
  /** CLI engines only: their own system prompt and native tools, resent on every request. */
  base: z.number().int().optional(),
  /** CLI engines only: earlier turns of the session plus this turn's tool calls and results. */
  history: z.number().int().optional(),
  /** Part of `tools` taken by each external MCP server (by server name); not a separate section. */
  mcpServers: z.record(z.string(), z.number().int()).optional(),
  /** Images in the conversation (screenshots), counted apart from `recentTail`. */
  images: z.number().int().optional(),
  /** How many images `images` counts; not a section. */
  imageCount: z.number().int().optional(),
  /** Part of `systemPrompt` taken by the bot's own instructions; not a separate section. */
  persona: z.number().int().optional(),
  /** Knowledge base: the catalog (next to the workspace memory) and the turn's relevant documents. */
  knowledge: z.number().int().optional(),
})
export type ContextComposition = z.infer<typeof ContextComposition>

export const LlmCallRow = z.object({
  id: z.string(),
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  purpose: z.string(),
  providerId: z.string().nullable(),
  providerType: z.string(),
  model: z.string(),
  /** Raw payloads; images are `milibot-blob:<sha256>` references. */
  request: z.unknown().nullable(),
  response: z.unknown().nullable(),
  ...TokenBuckets.shape,
  costUsd: z.number().nullable(),
  costSource: CostSource,
  contextComposition: ContextComposition.nullable(),
  stopReason: z.string().nullable(),
  generationId: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Attempts the provider SDK retried before this result (e.g. HTTP 429). */
  retries: z.number().int().optional(),
  createdAt: z.number().int(),
  /** Per-model breakdown when the call used several models or reported it (Claude Code `modelUsage`). */
  models: z.array(LlmCallModelUsage).optional(),
})
export type LlmCallRow = z.infer<typeof LlmCallRow>

export const ToolCallRow = z.object({
  id: z.string(),
  llmCallId: z.string().nullable(),
  botId: z.string().nullable(),
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  toolName: z.string(),
  arguments: z.unknown().nullable(),
  result: z.unknown().nullable(),
  status: ActivityStepStatus,
  error: z.string().nullable(),
  screenshotSha: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  /** As in the activity card. */
  kind: z.string().optional(),
  detail: z.string().optional(),
  /** Claude Code bookkeeping tools (todo lists, tool search…) that the activity card hides. */
  hidden: z.boolean().optional(),
})
export type ToolCallRow = z.infer<typeof ToolCallRow>

const DebugListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Only this turn. */
  turnId: z.string().optional(),
  /** `false` leaves out request/response payloads (fetch one call with `getLlmCall`). */
  payloads: queryBool(true),
})

/** Tokens, cost and errors of the LLM calls of one conversation. */
export const DebugTotals = z.object({
  calls: z.number().int(),
  errors: z.number().int(),
  costUsd: z.number(),
  ...TokenBuckets.shape,
  tokens: z.number().int(),
  /** Cache reads / every prompt token (input + cache reads + cache writes); null without prompt tokens. */
  cacheHitRate: z.number().nullable(),
})
export type DebugTotals = z.infer<typeof DebugTotals>

export const DebugTurn = z.object({
  turnId: z.string(),
  botId: z.string().nullable(),
  startedAt: z.number().int(),
  calls: z.number().int(),
  costUsd: z.number(),
  tokens: z.number().int(),
  /** The latest user or bot message before its first call. */
  trigger: z
    .object({
      messageId: z.string(),
      authorType: AuthorType,
      authorBotId: z.string().nullable(),
      snippet: z.string(),
    })
    .nullable(),
})
export type DebugTurn = z.infer<typeof DebugTurn>

export const ConversationDebug = z.object({
  totals: DebugTotals,
  /** Local day. */
  today: DebugTotals,
  byModel: z.array(DebugTotals.extend({ model: z.string() })),
  turns: z.array(DebugTurn),
  /** Composition of the latest call of each bot of the conversation that recorded one. */
  latestComposition: z.array(
    z.object({
      llmCallId: z.string(),
      botId: z.string().nullable(),
      model: z.string(),
      createdAt: z.number().int(),
      composition: ContextComposition,
    }),
  ),
})
export type ConversationDebug = z.infer<typeof ConversationDebug>

export const Blob = z.object({
  sha256: z.string(),
  mediaType: z.string(),
  data: z.string(),
})

export const DebugStorage = z.object({
  path: z.string(),
  /** Screenshots and payload images on disk. */
  blobsBytes: z.number().int(),
  /** Raw request/response/tool payloads kept in the database. */
  payloadBytes: z.number().int(),
  totalBytes: z.number().int(),
})
export type DebugStorage = z.infer<typeof DebugStorage>

export const DebugPurgeResult = z.object({
  payloadsCleared: z.number().int(),
  blobsRemoved: z.number().int(),
  storage: DebugStorage,
})

export const debugEndpoints = {
  listLlmCalls: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/conversations/:conversationId/llm-calls',
    query: DebugListQuery,
    response: z.array(LlmCallRow),
  }),
  listToolCalls: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/conversations/:conversationId/tool-calls',
    query: DebugListQuery,
    response: z.array(ToolCallRow),
  }),
  getBlob: endpoint({ method: 'GET', path: '/w/:workspaceId/blobs/:sha', response: Blob }),
  /** Patches of the files one tool call changed. */
  getToolCallDiff: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/tool-calls/:toolCallId/diff',
    response: StepDiff,
  }),
  /** One LLM call with its request/response payloads. */
  getLlmCall: endpoint({ method: 'GET', path: '/w/:workspaceId/llm-calls/:callId', response: LlmCallRow }),
  getConversationDebug: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/conversations/:conversationId/debug',
    response: ConversationDebug,
  }),
  getDebugStorage: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/debug/storage',
    response: DebugStorage,
  }),
  /** Drops payloads and screenshots older than the retention settings now. */
  purgeDebugData: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/debug/purge',
    response: DebugPurgeResult,
  }),
}
