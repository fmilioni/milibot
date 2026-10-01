import { type Bot, clipLine, estimateTokens } from '@milibot/shared'

import { conversationSummaryPrompt, SUMMARY_SYSTEM_PROMPT, summaryMergePrompt } from '../prompts/summaries'
import { messageToChat } from './chat-messages'
import { summaryWatermark } from './context-builder'
import { messageTokens } from './tokens'
import type { ConversationMemorySummary, MemoryBackend, MemoryConfig, StoredMessage } from './types'

const TRANSCRIPT_MESSAGE_CHARS = 4000
const MAX_ROUNDS = 8
const MAX_MERGES = 4

export interface SummarizeRequest {
  system: string
  prompt: string
  maxOutputTokens: number
  level: number
}

/** Runs one summarization call (model resolution, logging); returns the text and the llm_calls id. */
type Summarizer = (request: SummarizeRequest) => Promise<{ text: string; llmCallId: string | null }>

/** `YYYY-MM-DD HH:MM` in the host's local time: the times the user sees and talks about. */
export function localStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const clip = (text: string, max: number) => clipLine(text, max, { whitespace: 'keep', withinMax: false })

/** One transcript line per message (null for what the summarizer does not need). */
export function transcriptLine(message: StoredMessage, bot: Bot, botsById: Map<string, Bot>): string | null {
  const content = message.content.trim()
  if (!content) return null
  if (message.payload?.type === 'text' && message.payload.streaming) return null
  const who =
    message.authorType === 'user'
      ? 'User'
      : message.authorType === 'system'
        ? 'System'
        : message.authorBotId === bot.id
          ? `You (${bot.name})`
          : (botsById.get(message.authorBotId ?? '')?.name ?? 'Another bot')
  switch (message.kind) {
    case 'text':
      return `[${localStamp(message.createdAt)}] ${who}: ${clip(content, TRANSCRIPT_MESSAGE_CHARS)}`
    case 'activity':
      return `[${localStamp(message.createdAt)}] ${who} used tools: ${clip(content.replace(/\n/g, '; '), 800)}`
    case 'card':
      if (message.payload?.type === 'error') return null
      return `[${localStamp(message.createdAt)}] ${who}: ${clip(content, message.payload?.type === 'routine_run' ? TRANSCRIPT_MESSAGE_CHARS : 400)}`
    case 'system_event':
      return `[${localStamp(message.createdAt)}] (${clip(content, 200)})`
    default:
      return null
  }
}

/** Tokens the message costs in the context tail (text messages only, as the builder sends them). */
function tailCost(message: StoredMessage, bot: Bot, botsById: Map<string, Bot>): number {
  const chat = messageToChat(message, bot, botsById)
  return chat ? messageTokens(chat) : 0
}

/**
 * Oldest block of unsummarized messages to compact, or null when the tail is within the threshold.
 * The block ends right before a user message, so the remaining tail starts with one.
 */
export function selectCompactionBlock(
  messages: StoredMessage[],
  bot: Bot,
  botsById: Map<string, Bot>,
  config: MemoryConfig,
): StoredMessage[] | null {
  const costs = messages.map((m) => tailCost(m, bot, botsById))
  let remaining = costs.reduce((a, b) => a + b, 0)
  if (remaining <= config.compactThresholdTokens) return null
  let blockTokens = 0
  let end = 0
  for (; end < messages.length; end++) {
    const message = messages[end] as StoredMessage
    if (message.payload?.type === 'text' && message.payload.streaming) break
    const reachedTarget = remaining <= config.compactKeepTokens || blockTokens >= config.compactBlockTokens
    if (reachedTarget && message.authorType === 'user') break
    if (blockTokens >= config.compactBlockTokens * 1.5) break
    remaining -= costs[end] as number
    blockTokens += estimateTokens(message.content)
  }
  if (end >= messages.length) end = messages.length - 1
  const block = messages.slice(0, end)
  return block.some((m) => m.kind === 'text') ? block : null
}

export interface CompactionInput {
  bot: Bot
  conversationId: string
  memory: MemoryBackend
  botsById: Map<string, Bot>
  config: MemoryConfig
  summarize: Summarizer
  signal?: AbortSignal
}

/**
 * Post-turn compaction of one bot × conversation: summarizes the oldest unsummarized messages
 * while the tail is over the threshold, then merges the oldest summaries while the active chain
 * is over its budget (hierarchical summaries). Messages stay in the database and searchable.
 */
export async function compactConversation(input: CompactionInput): Promise<ConversationMemorySummary[]> {
  const { bot, conversationId, memory, config } = input
  const created: ConversationMemorySummary[] = []
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (input.signal?.aborted) return created
    const active = memory.activeSummaries(bot.id, conversationId)
    const pending = memory.messagesAfter(conversationId, summaryWatermark(active), { limit: 5000 })
    const block = selectCompactionBlock(pending, bot, input.botsById, config)
    if (!block) break
    const transcript = block
      .map((m) => transcriptLine(m, bot, input.botsById))
      .filter((l): l is string => l !== null)
      .join('\n')
    const previous = active.at(-1)?.content ?? null
    const { text, llmCallId } = await input.summarize({
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: conversationSummaryPrompt(transcript, previous),
      maxOutputTokens: 1024,
      level: 0,
    })
    if (!text.trim()) throw new Error('summarizer returned an empty summary')
    created.push(
      memory.saveSummary({
        botId: bot.id,
        conversationId,
        level: 0,
        fromSeq: (block[0] as StoredMessage).seq,
        toSeq: (block.at(-1) as StoredMessage).seq,
        content: text.trim(),
        tokenCount: estimateTokens(text.trim()),
        llmCallId,
        childIds: [],
      }),
    )
  }

  for (let merge = 0; merge < MAX_MERGES; merge++) {
    if (input.signal?.aborted) break
    const active = memory.activeSummaries(bot.id, conversationId)
    const total = active.reduce((sum, s) => sum + s.tokenCount, 0)
    if (total <= config.summaryBudgetTokens || active.length < 2) break
    const group = active.slice(0, Math.max(2, Math.ceil(active.length / 2)))
    const { text, llmCallId } = await input.summarize({
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: summaryMergePrompt(group.map((s) => s.content)),
      maxOutputTokens: 1500,
      level: Math.max(...group.map((s) => s.level)) + 1,
    })
    if (!text.trim()) throw new Error('summarizer returned an empty summary')
    created.push(
      memory.saveSummary({
        botId: bot.id,
        conversationId,
        level: Math.max(...group.map((s) => s.level)) + 1,
        fromSeq: (group[0] as ConversationMemorySummary).fromSeq,
        toSeq: (group.at(-1) as ConversationMemorySummary).toSeq,
        content: text.trim(),
        tokenCount: estimateTokens(text.trim()),
        llmCallId,
        childIds: group.map((s) => s.id),
      }),
    )
  }
  return created
}
