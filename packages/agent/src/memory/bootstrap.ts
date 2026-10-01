import { createHash } from 'node:crypto'

import { type Bot, estimateTokens } from '@milibot/shared'

import { transcriptLine } from './compaction'
import {
  formatMemoryBlock,
  formatSummariesBlock,
  formatWorkspaceMemoryBlock,
  summaryWatermark,
} from './context-builder'
import type { MemoryBackend, MemoryConfig, StoredMessage } from './types'

const RECAP_FETCH_LIMIT = 200
/** The recap only bridges the gap to the pending input; history_search has the rest. */
const RECAP_MAX_TOKENS = 800
const RECAP_LINE_CHARS = 700

export interface MemoryBootstrap {
  /** Memory text for the model; empty when there is nothing to inject. */
  text: string
  /** Hash of the memory + summaries part (the recap is excluded): changes when they change. */
  digest: string
  sections: { longTermMemory: number; summaries: number; recap: number }
}

export interface MemoryBootstrapInput {
  bot: Bot
  conversationId: string
  memory: MemoryBackend
  botsById: Map<string, Bot>
  config: MemoryConfig
  /**
   * Add the last messages of the conversation (before the pending input) for a session that starts
   * without its previous context (first start, lost session, rotation).
   */
  recap: boolean
  /** Knowledge base catalog (part of the stable memory: a change reaches resumed sessions as a note). */
  knowledgeCatalog?: string
}

/**
 * Milibot memory for a CLI session (which keeps its own context): workspace notes + pinned notes + the
 * conversation's summary chain, plus a short recap of recent messages when the session starts from
 * scratch. Used for `--append-system-prompt-file` on fresh sessions and as a note on resumed ones.
 */
export function buildMemoryBootstrap(input: MemoryBootstrapInput): MemoryBootstrap {
  const { bot, memory, config } = input
  const workspaceText = formatWorkspaceMemoryBlock(
    memory.workspaceNotes(),
    config.workspaceMemoryBudgetTokens,
  ).text
  const botMemoryText = formatMemoryBlock(memory.pinnedNotes(bot.id), config.memoryBudgetTokens).text
  const memoryText = [workspaceText, botMemoryText].filter(Boolean).join('\n\n')
  const summaries = memory.activeSummaries(bot.id, input.conversationId)
  const summariesText = formatSummariesBlock(summaries, config.summaryBudgetTokens)
  const recapText = input.recap
    ? formatRecap(
        memory.messagesAfter(input.conversationId, summaryWatermark(summaries), {
          limit: RECAP_FETCH_LIMIT,
          newest: true,
        }),
        bot,
        input.botsById,
        Math.min(config.recapBudgetTokens, RECAP_MAX_TOKENS),
      )
    : ''
  const catalog = input.knowledgeCatalog?.trim() ?? ''
  const stable = [memoryText, catalog, summariesText].filter(Boolean).join('\n\n')
  const memoryBlock = stable
    ? `# Milibot memory\nMilibot keeps your memory across sessions; this is what you know from before.\n\n${stable}`
    : ''
  return {
    text: [memoryBlock, recapText].filter(Boolean).join('\n\n'),
    digest: memoryDigest(stable),
    sections: {
      longTermMemory: (memoryText ? estimateTokens(memoryText) : 0) + (catalog ? estimateTokens(catalog) : 0),
      summaries: summariesText ? estimateTokens(summariesText) : 0,
      recap: recapText ? estimateTokens(recapText) : 0,
    },
  }
}

export function memoryDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * What the recap keeps: the user's and the bots' chat text, plus this bot's routine instructions. Tool
 * activity, screen-control events and other system lines are noise for a session that starts over.
 */
function isRecapMessage(message: StoredMessage, bot: Bot): boolean {
  if (message.kind === 'text') return message.authorType === 'user' || message.authorType === 'bot'
  return (
    message.kind === 'card' && message.payload?.type === 'routine_run' && message.payload.botId === bot.id
  )
}

/** Latest messages before the pending input (what arrived after the bot's last reply is the input). */
function formatRecap(
  messages: StoredMessage[],
  bot: Bot,
  botsById: Map<string, Bot>,
  budget: number,
): string {
  let end = messages.length
  while (end > 0) {
    const m = messages[end - 1] as StoredMessage
    if (m.authorType === 'bot' && m.authorBotId === bot.id && m.kind === 'text') break
    end--
  }
  const header = '# Recent messages\nThe last messages of this conversation before this session started:'
  let used = estimateTokens(header)
  const lines: string[] = []
  for (let i = end - 1; i >= 0; i--) {
    const message = messages[i] as StoredMessage
    if (!isRecapMessage(message, bot)) continue
    const raw = transcriptLine(message, bot, botsById)
    if (!raw) continue
    const line = raw.length > RECAP_LINE_CHARS ? `${raw.slice(0, RECAP_LINE_CHARS)}…` : raw
    const cost = estimateTokens(line)
    if (used + cost > budget) break
    used += cost
    lines.unshift(line)
  }
  return lines.length ? `${header}\n${lines.join('\n')}` : ''
}
