import {
  type ConversationDebug,
  type DebugTotals,
  type DebugTurn,
  InstructionFileInfo,
} from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'
import { startOfLocalDay } from '../../util/time'

interface TotalsRow {
  calls: number
  errors: number
  cost: number
  input: number
  cached_read: number
  cache_write: number
  output: number
  reasoning: number
}

const SUMS = `COUNT(*) AS calls, COALESCE(SUM(error IS NOT NULL), 0) AS errors, COALESCE(SUM(cost), 0) AS cost,
  COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached_read), 0) AS cached_read,
  COALESCE(SUM(cache_write), 0) AS cache_write, COALESCE(SUM(output), 0) AS output,
  COALESCE(SUM(reasoning), 0) AS reasoning`

const CALLS = `SELECT c.id, c.model, c.error, c.created_at, c.cost_usd AS cost, c.input_tokens AS input,
  c.cached_read_tokens AS cached_read, c.cache_write_tokens AS cache_write, c.output_tokens AS output,
  c.reasoning_tokens AS reasoning
  FROM llm_calls c WHERE c.conversation_id = @conversationId`

/** One row per model of each call: the per-model breakdown when there is one, else the call itself. */
const CALL_MODELS = `SELECT m.model, NULL AS error, m.cost_usd AS cost, m.input_tokens AS input,
  m.cached_read_tokens AS cached_read, m.cache_write_tokens AS cache_write, m.output_tokens AS output,
  m.reasoning_tokens AS reasoning
  FROM llm_call_models m JOIN llm_calls c ON c.id = m.llm_call_id WHERE c.conversation_id = @conversationId
  UNION ALL
  SELECT c.model, c.error, c.cost, c.input, c.cached_read, c.cache_write, c.output, c.reasoning
  FROM (${CALLS}) c WHERE NOT EXISTS (SELECT 1 FROM llm_call_models m WHERE m.llm_call_id = c.id)`

const SNIPPET_CHARS = 120

function debugTotals(r: TotalsRow): DebugTotals {
  const prompt = r.input + r.cached_read + r.cache_write
  return {
    calls: r.calls,
    errors: r.errors,
    costUsd: r.cost,
    inputTokens: r.input,
    cachedReadTokens: r.cached_read,
    cacheWriteTokens: r.cache_write,
    outputTokens: r.output,
    reasoningTokens: r.reasoning,
    tokens: prompt + r.output + r.reasoning,
    cacheHitRate: prompt > 0 ? r.cached_read / prompt : null,
  }
}

function snippet(content: string): string {
  const line = content.replace(/\s+/g, ' ').trim()
  return line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS - 1)}…` : line
}

/** Aggregates of one conversation's LLM calls for the debug drawer. */
export class DebugStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  conversation(conversationId: string): ConversationDebug {
    const params = { conversationId }
    const totals = this.db.prepare(`SELECT ${SUMS} FROM (${CALLS})`).get(params) as TotalsRow
    const today = this.db
      .prepare(`SELECT ${SUMS} FROM (${CALLS}) WHERE created_at >= @from`)
      .get({ ...params, from: startOfLocalDay(this.now()) }) as TotalsRow
    const byModel = this.db
      .prepare(`SELECT model, ${SUMS} FROM (${CALL_MODELS}) GROUP BY model ORDER BY cost DESC, model`)
      .all(params) as Array<TotalsRow & { model: string }>
    return {
      totals: debugTotals(totals),
      today: debugTotals(today),
      byModel: byModel.map((r) => ({ model: r.model, ...debugTotals(r) })),
      turns: this.turns(conversationId),
      latestComposition: this.latestComposition(conversationId),
    }
  }

  private turns(conversationId: string): DebugTurn[] {
    const rows = this.db
      .prepare(
        `SELECT turn_id, MIN(bot_id) AS bot_id, MIN(created_at) AS started_at, COUNT(*) AS calls,
           COALESCE(SUM(cost_usd), 0) AS cost,
           COALESCE(SUM(input_tokens + cached_read_tokens + cache_write_tokens + output_tokens + reasoning_tokens), 0) AS tokens
         FROM llm_calls WHERE conversation_id = ? AND turn_id IS NOT NULL
         GROUP BY turn_id ORDER BY started_at`,
      )
      .all(conversationId) as Array<{
      turn_id: string
      bot_id: string | null
      started_at: number
      calls: number
      cost: number
      tokens: number
    }>
    const trigger = this.db.prepare(
      `SELECT id, author_type, author_bot_id, content FROM messages
       WHERE conversation_id = ? AND kind = 'text' AND created_at <= ?
         AND (author_bot_id IS NULL OR author_bot_id != ?) AND author_type != 'system'
       ORDER BY seq DESC LIMIT 1`,
    )
    return rows.map((r) => {
      const message = trigger.get(conversationId, r.started_at, r.bot_id ?? '') as
        | {
            id: string
            author_type: 'user' | 'bot' | 'system'
            author_bot_id: string | null
            content: string
          }
        | undefined
      return {
        turnId: r.turn_id,
        botId: r.bot_id,
        startedAt: r.started_at,
        calls: r.calls,
        costUsd: r.cost,
        tokens: r.tokens,
        trigger: message
          ? {
              messageId: message.id,
              authorType: message.author_type,
              authorBotId: message.author_bot_id,
              snippet: snippet(message.content),
            }
          : null,
      }
    })
  }

  private latestComposition(conversationId: string): ConversationDebug['latestComposition'] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.bot_id, c.model, c.created_at, c.context_composition,
           json_extract(c.request_json, '$.instructionFiles') AS instruction_files FROM llm_calls c
         WHERE c.conversation_id = ? AND c.context_composition IS NOT NULL AND c.purpose IN ('turn', 'intro')
           AND c.created_at = (SELECT MAX(o.created_at) FROM llm_calls o WHERE o.conversation_id = c.conversation_id
             AND o.context_composition IS NOT NULL AND o.purpose IN ('turn', 'intro')
             AND o.bot_id IS c.bot_id)
         ORDER BY c.created_at DESC`,
      )
      .all(conversationId) as Array<{
      id: string
      bot_id: string | null
      model: string
      created_at: number
      context_composition: string
      instruction_files: string | null
    }>
    const seen = new Set<string | null>()
    return rows.flatMap((r) => {
      if (seen.has(r.bot_id)) return []
      seen.add(r.bot_id)
      const composition = parseJson<ConversationDebug['latestComposition'][number]['composition'] | null>(
        r.context_composition,
        null,
      )
      if (!composition) return []
      const files = InstructionFileInfo.array().safeParse(parseJson<unknown>(r.instruction_files, []))
      return [
        {
          llmCallId: r.id,
          botId: r.bot_id,
          model: r.model,
          createdAt: r.created_at,
          composition,
          instructionFiles: files.success ? files.data : [],
        },
      ]
    })
  }
}
