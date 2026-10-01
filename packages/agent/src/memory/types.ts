import {
  type ConversationMemorySummary,
  MEMORY_SETTING_KEYS,
  type MemoryNote,
  type MemoryScope,
  type MemorySettings,
  type Message,
  type ProjectView,
} from '@milibot/shared'

export type { ConversationMemorySummary, MemoryNote, MemoryScope }

/** A message with its global insertion order (`messages.seq`), used as compaction watermark. */
export type StoredMessage = Message & { seq: number }

export interface MessageSearchOptions {
  /** Only conversations this bot is (or was) a member of. */
  botId: string
  /** Restrict to one conversation. */
  conversationId?: string | null
  /** Skip messages of `conversationId` with `seq >= seq` (they are already in the context tail). */
  excludeFrom?: { conversationId: string; seq: number } | null
  limit: number
}

export interface NewSummary {
  botId: string
  conversationId: string
  level: number
  fromSeq: number
  toSeq: number
  content: string
  tokenCount: number
  llmCallId: string | null
  /** Summaries merged into this one (level > 0); they leave the active chain. */
  childIds: string[]
}

/**
 * Storage of the memory system (implemented over SQLite + FTS5 by the daemon, in memory for tests).
 * Search methods take already-normalized terms (see `searchTerms`); ranking is the backend's.
 */
export interface MemoryBackend {
  /** Pinned notes of the bot, oldest first. */
  pinnedNotes(botId: string): MemoryNote[]
  /** General notes shared by every bot of the workspace (no project), oldest first. */
  workspaceNotes(): MemoryNote[]
  /** Workspace notes of one project, oldest first. */
  projectNotes(projectId: string): MemoryNote[]
  /**
   * `scope: 'workspace'` saves a note shared by every bot (stored without a bot), in `projectId` when
   * given (a project note).
   */
  saveNote(input: {
    botId: string
    content: string
    pinned: boolean
    scope?: MemoryScope
    projectId?: string | null
    sourceMessageId?: string | null
  }): MemoryNote
  /** Every note of the bot (pinned or not), oldest first. */
  botNotes(botId: string): MemoryNote[]
  /**
   * Replaces a note's text (and moves it to `scope`; workspace notes have no bot). `projectId` moves a
   * workspace note to that project (null: general); undefined keeps it.
   */
  reviseNote(
    id: string,
    input: { content: string; scope: MemoryScope; botId: string; projectId?: string | null },
  ): MemoryNote
  /** The bot's notes and the workspace ones of the projects in `project` (default: every project). */
  searchNotes(botId: string, terms: string[], limit: number, project?: ProjectView): MemoryNote[]
  searchMessages(terms: string[], options: MessageSearchOptions): StoredMessage[]
  /** Active summary chain (`parentId = null`) of the bot in the conversation, oldest first. */
  activeSummaries(botId: string, conversationId: string): ConversationMemorySummary[]
  /** Messages with `seq > afterSeq` in chronological order; `newest` takes the last `limit` ones. */
  messagesAfter(
    conversationId: string,
    afterSeq: number,
    options: { limit: number; newest?: boolean },
  ): StoredMessage[]
  /** Level 0 also marks the covered messages as compacted. */
  saveSummary(summary: NewSummary): ConversationMemorySummary
}

export type MemoryConfig = Omit<MemorySettings, 'summaryModel'> & {
  /** Compaction starts when the unsummarized tail exceeds this. */
  compactThresholdTokens: number
  /** Compaction summarizes the oldest messages until the tail is back to this size. */
  compactKeepTokens: number
  /** Max transcript size sent in one summarization call. */
  compactBlockTokens: number
  retrievedTopK: number
  /** Recent messages injected when a CLI session has to start from scratch. */
  recapBudgetTokens: number
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  tailBudgetTokens: 16_000,
  memoryBudgetTokens: 2_000,
  workspaceMemoryBudgetTokens: 1_000,
  summaryBudgetTokens: 3_000,
  retrievedBudgetTokens: 1_500,
  compactThresholdTokens: 16_000,
  compactKeepTokens: 8_000,
  compactBlockTokens: 12_000,
  retrievedTopK: 6,
  recapBudgetTokens: 2_500,
}

/** Reads the configurable budgets from workspace settings; compaction follows the tail budget. */
export function memoryConfig(
  getSetting: <T>(key: string, fallback: T) => T,
  base: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): MemoryConfig {
  const num = (key: string, fallback: number) => {
    const value = getSetting<unknown>(key, fallback)
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  }
  const tailBudgetTokens = num(MEMORY_SETTING_KEYS.tailBudgetTokens, base.tailBudgetTokens)
  const scale = tailBudgetTokens / base.tailBudgetTokens
  return {
    ...base,
    tailBudgetTokens,
    memoryBudgetTokens: num(MEMORY_SETTING_KEYS.memoryBudgetTokens, base.memoryBudgetTokens),
    workspaceMemoryBudgetTokens: num(
      MEMORY_SETTING_KEYS.workspaceMemoryBudgetTokens,
      base.workspaceMemoryBudgetTokens,
    ),
    summaryBudgetTokens: num(MEMORY_SETTING_KEYS.summaryBudgetTokens, base.summaryBudgetTokens),
    retrievedBudgetTokens: num(MEMORY_SETTING_KEYS.retrievedBudgetTokens, base.retrievedBudgetTokens),
    compactThresholdTokens: Math.round(base.compactThresholdTokens * scale),
    compactKeepTokens: Math.round(base.compactKeepTokens * scale),
  }
}

/** Share of a model's context window the memory budgets may take; the rest is prompt, tools and answer. */
const CONTEXT_WINDOW_MEMORY_SHARE = 0.5

/**
 * Budgets scaled down so they fit a small context window (e.g. an 8k local model registered with
 * its context). Unknown or large windows keep the configured budgets.
 */
export function fitMemoryConfig(
  config: MemoryConfig,
  contextWindow: number | null | undefined,
): MemoryConfig {
  if (!contextWindow || contextWindow <= 0) return config
  const total =
    config.tailBudgetTokens +
    config.memoryBudgetTokens +
    config.workspaceMemoryBudgetTokens +
    config.summaryBudgetTokens +
    config.retrievedBudgetTokens
  const room = Math.floor(contextWindow * CONTEXT_WINDOW_MEMORY_SHARE)
  if (total === 0 || total <= room) return config
  const factor = room / total
  const scaled = (n: number) => Math.floor(n * factor)
  return {
    ...config,
    tailBudgetTokens: scaled(config.tailBudgetTokens),
    memoryBudgetTokens: scaled(config.memoryBudgetTokens),
    workspaceMemoryBudgetTokens: scaled(config.workspaceMemoryBudgetTokens),
    summaryBudgetTokens: scaled(config.summaryBudgetTokens),
    retrievedBudgetTokens: scaled(config.retrievedBudgetTokens),
    compactThresholdTokens: scaled(config.compactThresholdTokens),
    compactKeepTokens: scaled(config.compactKeepTokens),
    compactBlockTokens: Math.min(config.compactBlockTokens, room),
    recapBudgetTokens: scaled(config.recapBudgetTokens),
  }
}
