import { z } from 'zod'

import { endpoint, Ok, queryBool } from '../http/endpoint'
import { ModelChoice } from '../models/reasoning'

/** `bot`: one bot's note; `workspace`: shared by every bot of the workspace (user profile, conventions). */
export const MemoryScope = z.enum(['bot', 'workspace'])
export type MemoryScope = z.infer<typeof MemoryScope>

/**
 * Long-term note (`memory_save`). Pinned bot notes are always in the bot's context; workspace notes
 * are always in every bot's context.
 */
export const MemoryNote = z.object({
  id: z.string(),
  scope: MemoryScope,
  botId: z.string().nullable(),
  /** Workspace notes only; null = general. */
  projectId: z.string().nullable(),
  content: z.string(),
  pinned: z.boolean(),
  tokenCount: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type MemoryNote = z.infer<typeof MemoryNote>

const CreateMemoryNoteBody = z.object({
  content: z.string().trim().min(1).max(4000),
  pinned: z.boolean().default(true),
  /** Workspace notes only. */
  projectId: z.string().nullable().optional(),
})

const UpdateMemoryNoteBody = z.object({
  content: z.string().trim().min(1).max(4000).optional(),
  pinned: z.boolean().optional(),
  /** Workspace notes only. */
  projectId: z.string().nullable().optional(),
})

/**
 * Summary of a block of a conversation from one bot's point of view. Level 0 covers messages
 * `[fromSeq, toSeq]`; level n merges level < n summaries, which then point to it via `parentId`.
 * The active chain (sent to the model) is the summaries with `parentId = null`.
 */
export const ConversationMemorySummary = z.object({
  id: z.string(),
  conversationId: z.string(),
  botId: z.string().nullable(),
  level: z.number().int(),
  parentId: z.string().nullable(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  content: z.string(),
  tokenCount: z.number().int(),
  llmCallId: z.string().nullable(),
  createdAt: z.number().int(),
})
export type ConversationMemorySummary = z.infer<typeof ConversationMemorySummary>

const ListSummariesQuery = z.object({
  botId: z.string().optional(),
  /** Only the active chain (what the model sees). */
  active: queryBool(false),
})

/** null = each bot's own model. */
export const SummaryModelSetting = ModelChoice.nullable()

export const MemorySettings = z.object({
  summaryModel: SummaryModelSetting,
  /** Recent messages kept verbatim in the context. */
  tailBudgetTokens: z.number().int().min(1000).max(200_000),
  memoryBudgetTokens: z.number().int().min(0).max(20_000),
  /** Shared by every bot. */
  workspaceMemoryBudgetTokens: z.number().int().min(0).max(10_000),
  /** Summary chain budget; overflowing chains are summarized again (hierarchically). */
  summaryBudgetTokens: z.number().int().min(500).max(30_000),
  /** Older messages/notes found by full-text search for the latest message. */
  retrievedBudgetTokens: z.number().int().min(0).max(20_000),
})
export type MemorySettings = z.infer<typeof MemorySettings>

const UpdateMemorySettingsBody = MemorySettings.partial()

export const memoryEndpoints = {
  listBotMemories: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/bots/:botId/memories',
    response: z.array(MemoryNote),
  }),
  createBotMemory: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/bots/:botId/memories',
    body: CreateMemoryNoteBody,
    response: MemoryNote,
  }),
  updateBotMemory: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/bots/:botId/memories/:memoryId',
    body: UpdateMemoryNoteBody,
    response: MemoryNote,
  }),
  deleteBotMemory: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/bots/:botId/memories/:memoryId',
    response: Ok,
  }),
  listConversationSummaries: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/conversations/:conversationId/summaries',
    query: ListSummariesQuery,
    response: z.array(ConversationMemorySummary),
  }),
  getMemorySettings: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/memory/settings',
    response: MemorySettings,
  }),
  updateMemorySettings: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/memory/settings',
    body: UpdateMemorySettingsBody,
    response: MemorySettings,
  }),
  listWorkspaceMemories: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/memories',
    response: z.array(MemoryNote),
  }),
  createWorkspaceMemory: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/memories',
    body: CreateMemoryNoteBody,
    response: MemoryNote,
  }),
  updateWorkspaceMemory: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/memories/:memoryId',
    body: UpdateMemoryNoteBody,
    response: MemoryNote,
  }),
  deleteWorkspaceMemory: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/memories/:memoryId',
    response: Ok,
  }),
}
