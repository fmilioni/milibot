import { type Bot, estimateTokens } from '@milibot/shared'

import type { WorkSessionView } from '../../environment'
import type { ChatMessage } from '../../llm/messages'
import type { ToolDefinition } from '../../llm/provider'
import { messagesTokens, messageTokens } from '../../memory/tokens'
import { SESSION_SUMMARY_SYSTEM, sessionSummaryPrompt } from '../../prompts/summaries'
import {
  compactionCut,
  renderForSummary,
  SESSION_KEEP_SHARE,
  summaryMessage,
} from '../../work-sessions/transcript'
import type { HostContext } from '../context'
import type { LaneKey } from '../lanes'
import { oneShot, oneShotEstimate } from '../turn/one-shot'
import type { SessionTranscript } from './session-context'

export interface SessionCompaction {
  bot: Bot
  session: WorkSessionView
  laneKey: LaneKey
  system: ChatMessage
  conversation: ChatMessage[]
  transcript: SessionTranscript
  tools: ToolDefinition[]
  budget: number
  signal: AbortSignal
}

/**
 * Keeps a session lane within its budget: when the context outgrows it, the oldest part of the transcript
 * (never splitting a tool call from its results) is folded into the rolling summary, down to about a third
 * of the budget. A failed summary leaves the context as it is.
 */
export async function compactSession(ctx: HostContext, input: SessionCompaction): Promise<void> {
  const { bot, session, conversation, transcript, signal } = input
  const seqs = transcript.seqs
  const fixedTokens = messageTokens(input.system) + estimateTokens(JSON.stringify(input.tools))
  if (fixedTokens + messagesTokens(conversation) <= input.budget) return
  const keep = Math.max(2_000, Math.floor(input.budget * SESSION_KEEP_SHARE) - fixedTokens)
  const cut = compactionCut(conversation, seqs, keep)
  if (cut === null) return
  const first = seqs.findIndex((s) => s >= 0)
  const dropped = conversation.slice(first, cut)
  const toSeq = Math.max(...seqs.slice(first, cut))
  const env = ctx.env()
  try {
    const resolved = await env.resolveSummaryModel(bot)
    if (resolved.kind === 'unavailable') throw new Error(resolved.reason)
    const prompt = sessionSummaryPrompt(transcript.summary, renderForSummary(dropped))
    const { text, llmCallId } = await oneShot(env, ctx.cli, {
      bot,
      resolved,
      record: { botId: bot.id, conversationId: session.conversationId, purpose: 'summary' },
      system: SESSION_SUMMARY_SYSTEM,
      prompt,
      maxOutputTokens: 3_000,
      estimate: oneShotEstimate(SESSION_SUMMARY_SYSTEM, { tail: prompt, summaries: transcript.summary }),
      signal,
    })
    if (!text.trim()) return
    env.workSessions.compactTranscript(session.id, input.laneKey, toSeq, text, llmCallId)
    conversation.splice(0, cut, summaryMessage(text))
    seqs.splice(0, cut, -1)
    transcript.summary = text
    env.log('info', 'work session compacted', {
      botId: bot.id,
      sessionId: session.id,
      toSeq,
      kept: messagesTokens(conversation),
    })
  } catch (err) {
    if (signal.aborted) throw err
    env.log('warn', 'work session compaction failed', {
      botId: bot.id,
      sessionId: session.id,
      err: (err as Error).message,
    })
  }
}
