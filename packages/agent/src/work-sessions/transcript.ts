import { CHARS_PER_TOKEN, clipLine, estimateTokens } from '@milibot/shared'

import type { TranscriptEntry } from '../environment'
import type { ChatMessage } from '../llm/messages'
import { messageTokens } from '../memory/tokens'
import { SUMMARY_PREFIX } from '../prompts/summaries'

/** Share of the model's context window a session lane's context may use before it is compacted. */
const SESSION_CONTEXT_SHARE = 0.65
/** Window assumed when the model's is not registered. */
const DEFAULT_SESSION_CONTEXT_WINDOW = 100_000
/** After compacting, what is kept of the transcript (as a share of the budget). */
export const SESSION_KEEP_SHARE = 0.35
/** Tokens of transcript sent to the summarizer at most (older parts are clipped harder). */
const SUMMARY_INPUT_TOKENS = 60_000
const RESULT_CHARS = 1_500
const ARGUMENT_CHARS = 600

export function sessionBudget(contextWindow: number | null | undefined): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_SESSION_CONTEXT_WINDOW
  return Math.floor(window * SESSION_CONTEXT_SHARE)
}

/** What the model sees of a lane's transcript, with the seq of each entry (-1: the summary, not stored). */
export interface SessionConversation {
  conversation: ChatMessage[]
  seqs: number[]
}

export function summaryMessage(summary: string): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}\n\n${summary.trim()}` }] }
}

/**
 * The lane's transcript as a conversation: the rolling summary first (as a user message), then the
 * uncompacted entries. Copies, so the loop can prune and extend them freely.
 */
export function sessionConversation(transcript: {
  summary: string | null
  entries: TranscriptEntry[]
}): SessionConversation {
  const conversation: ChatMessage[] = []
  const seqs: number[] = []
  if (transcript.summary?.trim()) {
    conversation.push(summaryMessage(transcript.summary))
    seqs.push(-1)
  }
  const start = conversation.length
  for (const entry of transcript.entries) {
    conversation.push({ ...entry.message, content: [...entry.message.content] } as ChatMessage)
    seqs.push(entry.seq)
  }
  // Results whose call was compacted (or lost in a crash) cannot be replayed.
  while (conversation[start]?.role === 'tool') {
    conversation.splice(start, 1)
    seqs.splice(start, 1)
  }
  return { conversation, seqs }
}

/**
 * Where to cut the conversation so that what stays fits `keepTokens`: never inside a tool exchange (the
 * kept part starts at a user or assistant entry) and never at the summary. Returns the index of the first
 * kept entry, or null when nothing can be compacted.
 */
export function compactionCut(
  conversation: ChatMessage[],
  seqs: number[],
  keepTokens: number,
): number | null {
  const firstStored = seqs.findIndex((s) => s >= 0)
  if (firstStored < 0) return null
  let best: number | null = null
  let kept = 0
  for (let i = conversation.length - 1; i > firstStored; i--) {
    kept += messageTokens(conversation[i] as ChatMessage)
    const role = conversation[i]?.role
    if (role === 'tool') continue
    if (best === null || kept <= keepTokens) best = i
    if (kept > keepTokens) break
  }
  return best
}

const clip = (text: string, max: number) => clipLine(text, max, { whitespace: 'trim' })

function partsText(message: ChatMessage): string {
  return message.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n')
}

/** The entries to summarize as plain text, clipped to what a summarizer call can take. */
export function renderForSummary(messages: ChatMessage[], maxTokens = SUMMARY_INPUT_TOKENS): string {
  const render = (resultChars: number, argumentChars: number) =>
    messages
      .map((m) => {
        if (m.role === 'user') return `USER:\n${partsText(m)}`
        if (m.role === 'tool')
          return `RESULT (${m.toolName}${m.isError ? ', error' : ''}):\n${clip(partsText(m), resultChars)}`
        if (m.role === 'assistant') {
          const calls = (m.toolCalls ?? []).map(
            (c) => `CALL ${c.name} ${clip(JSON.stringify(c.arguments ?? {}), argumentChars)}`,
          )
          return [partsText(m).trim() ? `YOU:\n${partsText(m)}` : '', ...calls].filter(Boolean).join('\n')
        }
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  let text = render(RESULT_CHARS, ARGUMENT_CHARS)
  if (estimateTokens(text) > maxTokens) text = render(300, 200)
  if (estimateTokens(text) > maxTokens) text = text.slice(-Math.floor(maxTokens * CHARS_PER_TOKEN))
  return text
}
