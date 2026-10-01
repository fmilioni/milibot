import type { LlmCallRecord } from '@milibot/agent'
import { type LlmCallModelUsage, type LlmCallRow, newId, type WorkspaceStatus } from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'
import { notFound } from '../../errors'
import { startOfLocalDay } from '../../util/time'

interface LlmCallDbRow {
  id: string
  bot_id: string | null
  conversation_id: string | null
  turn_id: string | null
  purpose: string
  provider_id: string | null
  provider_type: string
  model: string
  request_json: string | null
  response_json: string | null
  input_tokens: number
  cached_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cost_usd: number | null
  cost_source: LlmCallRow['costSource']
  context_composition: string | null
  stop_reason: string | null
  generation_id: string | null
  latency_ms: number | null
  retries: number
  error: string | null
  created_at: number
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/** The `llm_calls` log (with each call's per-model usage) and the spend sums read from it. */
export class LlmCallStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  insert(record: LlmCallRecord): string {
    const id = newId('llmCall')
    this.db.transaction(() => this.insertRows(id, record))()
    return id
  }

  private insertRows(id: string, record: LlmCallRecord): void {
    const createdAt = this.now()
    this.db
      .prepare(
        `INSERT INTO llm_calls (id, bot_id, conversation_id, turn_id, purpose, provider_id, provider_type, model,
           request_json, response_json, input_tokens, cached_read_tokens, cache_write_tokens, output_tokens,
           reasoning_tokens, cost_usd, cost_source, context_composition, stop_reason, generation_id, latency_ms,
           error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.botId,
        record.conversationId,
        record.turnId,
        record.purpose,
        record.providerId,
        record.providerType,
        record.model,
        json(record.request),
        json(record.response),
        record.usage.inputTokens,
        record.usage.cachedReadTokens,
        record.usage.cacheWriteTokens,
        record.usage.outputTokens,
        record.usage.reasoningTokens,
        record.usage.costUsd,
        record.usage.costSource,
        json(record.contextComposition),
        record.stopReason,
        record.generationId,
        record.latencyMs === null ? null : Math.round(record.latencyMs),
        record.error,
        createdAt,
      )
    const insertModel = this.db.prepare(
      `INSERT INTO llm_call_models (llm_call_id, model, input_tokens, cached_read_tokens, cache_write_tokens,
         output_tokens, reasoning_tokens, cost_usd, web_search_requests, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const m of record.models ?? []) {
      insertModel.run(
        id,
        m.model,
        m.inputTokens,
        m.cachedReadTokens,
        m.cacheWriteTokens,
        m.outputTokens,
        m.reasoningTokens,
        m.costUsd,
        m.webSearchRequests,
        createdAt,
      )
    }
  }

  list(
    conversationId: string,
    options: { limit: number; turnId?: string | undefined; payloads?: boolean },
  ): LlmCallRow[] {
    const rows = (
      options.turnId
        ? this.db
            .prepare(
              'SELECT * FROM llm_calls WHERE conversation_id = ? AND turn_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(conversationId, options.turnId, options.limit)
        : this.db
            .prepare(
              'SELECT * FROM llm_calls WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
            )
            .all(conversationId, options.limit)
    ) as LlmCallDbRow[]
    const models = this.modelsOf(rows.map((r) => r.id))
    return rows.reverse().map((r) => this.toLlmCall(r, models.get(r.id), options.payloads ?? true))
  }

  get(id: string): LlmCallRow {
    const row = this.db.prepare('SELECT * FROM llm_calls WHERE id = ?').get(id) as LlmCallDbRow | undefined
    if (!row) throw notFound('llm call', id)
    return this.toLlmCall(row, this.modelsOf([id]).get(id), true)
  }

  private toLlmCall(r: LlmCallDbRow, models: LlmCallModelUsage[] | undefined, payloads: boolean): LlmCallRow {
    return {
      id: r.id,
      botId: r.bot_id,
      conversationId: r.conversation_id,
      turnId: r.turn_id,
      purpose: r.purpose,
      providerId: r.provider_id,
      providerType: r.provider_type,
      model: r.model,
      request: payloads ? parseJson<unknown>(r.request_json, null) : null,
      response: payloads ? parseJson<unknown>(r.response_json, null) : null,
      inputTokens: r.input_tokens,
      cachedReadTokens: r.cached_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      outputTokens: r.output_tokens,
      reasoningTokens: r.reasoning_tokens,
      costUsd: r.cost_usd,
      costSource: r.cost_source,
      contextComposition: parseJson(r.context_composition, null),
      stopReason: r.stop_reason,
      generationId: r.generation_id,
      latencyMs: r.latency_ms,
      error: r.error,
      retries: r.retries,
      createdAt: r.created_at,
      ...(models ? { models } : {}),
    }
  }

  private modelsOf(ids: string[]): Map<string, LlmCallModelUsage[]> {
    const result = new Map<string, LlmCallModelUsage[]>()
    if (ids.length === 0) return result
    const rows = this.db
      .prepare(
        `SELECT * FROM llm_call_models WHERE llm_call_id IN (${ids.map(() => '?').join(',')}) ORDER BY cost_usd DESC`,
      )
      .all(...ids) as Array<{
      llm_call_id: string
      model: string
      input_tokens: number
      cached_read_tokens: number
      cache_write_tokens: number
      output_tokens: number
      reasoning_tokens: number
      cost_usd: number | null
      web_search_requests: number
    }>
    for (const r of rows) {
      const list = result.get(r.llm_call_id) ?? []
      list.push({
        model: r.model,
        inputTokens: r.input_tokens,
        cachedReadTokens: r.cached_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        outputTokens: r.output_tokens,
        reasoningTokens: r.reasoning_tokens,
        costUsd: r.cost_usd,
        webSearchRequests: r.web_search_requests,
      })
      result.set(r.llm_call_id, list)
    }
    return result
  }

  /** Spend of today and of the footer counter (since its last reset today, else since midnight). */
  usageStatus(now: number, resetAt: number | null): Pick<WorkspaceStatus, 'usageToday' | 'usageCounter'> {
    const today = startOfLocalDay(now)
    const reset = typeof resetAt === 'number' && resetAt > today
    const since = reset ? resetAt : today
    const usageToday = this.usageSince(today)
    return { usageToday, usageCounter: { since, reset, ...(reset ? this.usageSince(since) : usageToday) } }
  }

  conversationCost(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_calls WHERE conversation_id = ?')
      .get(conversationId) as { cost: number }
    return row.cost
  }

  usageSince(since: number): { costUsd: number; tokens: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(input_tokens + cached_read_tokens + cache_write_tokens + output_tokens + reasoning_tokens), 0) AS tokens
         FROM llm_calls WHERE created_at >= ?`,
      )
      .get(since) as { cost: number; tokens: number }
    return { costUsd: row.cost, tokens: row.tokens }
  }
}
