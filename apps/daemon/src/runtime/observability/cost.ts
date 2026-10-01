import {
  COST_SYSTEM_ROWS,
  type CostDay,
  type CostGroupBy,
  type CostOverview,
  type CostSummary,
  type CostSummaryRow,
  type CostTotals,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { startOfLocalDay } from '../../util/time'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RANGE_MS = 30 * DAY_MS

interface AggregateRow {
  key: string | null
  cost: number
  input: number
  cached_read: number
  cache_write: number
  output: number
  reasoning: number
  calls: number
}

const SUMS = `COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(input), 0) AS input,
  COALESCE(SUM(cached_read), 0) AS cached_read, COALESCE(SUM(cache_write), 0) AS cache_write,
  COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning`

/** One row per LLM call, with the call's own columns. */
const CALLS = `SELECT c.id, c.bot_id, c.purpose, c.model, c.created_at, c.cost_usd AS cost, c.input_tokens AS input,
  c.cached_read_tokens AS cached_read, c.cache_write_tokens AS cache_write, c.output_tokens AS output,
  c.reasoning_tokens AS reasoning
  FROM llm_calls c WHERE c.created_at >= @from AND c.created_at < @to`

/** `groupBy=bot` key: Milibot's own work (triage, summaries) gets a synthetic row instead of a bot. */
const BOT_KEY = `CASE WHEN purpose = 'triage' THEN 'system:triage'
  WHEN purpose IN ('summary', 'summary_merge') THEN 'system:summaries'
  WHEN purpose = 'knowledge_summary' THEN 'system:knowledge_summaries'
  WHEN purpose = 'embedding' THEN 'system:knowledge_index' ELSE bot_id END`

/**
 * One row per model used in each call: the Claude Code breakdown when the call has one, else the
 * call itself under its model.
 */
const CALL_MODELS = `SELECT m.llm_call_id AS id, m.model, m.cost_usd AS cost, m.input_tokens AS input,
  m.cached_read_tokens AS cached_read, m.cache_write_tokens AS cache_write, m.output_tokens AS output,
  m.reasoning_tokens AS reasoning
  FROM llm_call_models m JOIN llm_calls c ON c.id = m.llm_call_id
  WHERE c.created_at >= @from AND c.created_at < @to
  UNION ALL
  SELECT c.id, c.model, c.cost, c.input, c.cached_read, c.cache_write, c.output, c.reasoning
  FROM (${CALLS}) c WHERE NOT EXISTS (SELECT 1 FROM llm_call_models m WHERE m.llm_call_id = c.id)`

function totals(r: Omit<AggregateRow, 'key'>): CostTotals {
  return {
    costUsd: r.cost,
    inputTokens: r.input,
    cachedReadTokens: r.cached_read,
    cacheWriteTokens: r.cache_write,
    outputTokens: r.output,
    reasoningTokens: r.reasoning,
    tokens: r.input + r.cached_read + r.cache_write + r.output + r.reasoning,
    calls: r.calls,
  }
}

/** Cost/token aggregation over `llm_calls` (+ `llm_call_models`) for charts and the sidebar footer. */
export class CostStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Today, 7 and 30 days, the daily chart of the last `chartDays` and the cache savings. */
  overview(chartDays: number, prices: CachePriceLookup): CostOverview {
    return costOverview(this.db, this.now(), chartDays, prices)
  }

  summary(query: { from?: number | undefined; to?: number | undefined; groupBy: CostGroupBy }): CostSummary {
    const to = query.to ?? this.now() + 1
    const from = query.from ?? to - DEFAULT_RANGE_MS
    const range = { from, to }
    const total = this.db
      .prepare(`SELECT ${SUMS}, COUNT(*) AS calls FROM (${CALLS})`)
      .get(range) as AggregateRow
    let rows: AggregateRow[]
    switch (query.groupBy) {
      case 'bot':
        rows = this.db
          .prepare(
            `SELECT ${BOT_KEY} AS key, ${SUMS}, COUNT(*) AS calls FROM (${CALLS}) GROUP BY key ORDER BY cost DESC`,
          )
          .all(range) as AggregateRow[]
        break
      case 'model':
        rows = this.db
          .prepare(
            `SELECT model AS key, ${SUMS}, COUNT(DISTINCT id) AS calls FROM (${CALL_MODELS}) GROUP BY model ORDER BY cost DESC`,
          )
          .all(range) as AggregateRow[]
        break
      case 'day':
        rows = this.db
          .prepare(
            `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS key, ${SUMS}, COUNT(*) AS calls
             FROM (${CALLS}) GROUP BY key ORDER BY key`,
          )
          .all(range) as AggregateRow[]
        break
    }
    const names =
      query.groupBy === 'bot'
        ? new Map<string, string>([
            ...(
              this.db.prepare('SELECT id, name FROM bots').all() as Array<{ id: string; name: string }>
            ).map((b) => [b.id, b.name] as const),
            ...Object.entries(COST_SYSTEM_ROWS),
          ])
        : null
    return {
      from,
      to,
      groupBy: query.groupBy,
      totals: totals(total),
      rows: rows.map((r): CostSummaryRow => ({
        key: r.key,
        label: names?.get(r.key ?? '') ?? null,
        ...totals(r),
      })),
    }
  }
}

/** Input and cache-read prices (US$ per 1M tokens) of a model, when known. */
export type CachePriceLookup = (
  providerType: string,
  providerId: string | null,
  model: string,
) => { input: number; cacheRead: number } | null

function dayKey(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local days `[first … today]`, oldest first. */
export function lastDays(now: number, count: number): string[] {
  const days: string[] = []
  const d = new Date(now)
  d.setHours(12, 0, 0, 0)
  for (let i = count - 1; i >= 0; i--) {
    const day = new Date(d)
    day.setDate(d.getDate() - i)
    days.push(dayKey(day.getTime()))
  }
  return days
}

/** Every day of the range present (zero when nothing ran), in order. */
export function fillDays(
  days: string[],
  rows: Array<{ key: string | null; costUsd: number; tokens: number }>,
): CostDay[] {
  const byDay = new Map(rows.map((r) => [r.key, r]))
  return days.map((day) => ({
    day,
    costUsd: byDay.get(day)?.costUsd ?? 0,
    tokens: byDay.get(day)?.tokens ?? 0,
  }))
}

/** Stat cards and daily chart of the costs screen. */
function costOverview(db: Db, now: number, chartDays: number, prices: CachePriceLookup): CostOverview {
  const costs = new CostStore(db, () => now)
  const to = now + 1
  const range = (daysBack: number) => {
    const t = costs.summary({ from: startOfLocalDay(now, daysBack), to, groupBy: 'day' }).totals
    return { costUsd: t.costUsd, tokens: t.tokens }
  }
  const from30 = startOfLocalDay(now, 29)
  const cacheRows = db
    .prepare(
      `SELECT c.provider_type AS type, c.provider_id AS providerId, m.model AS model,
         SUM(m.cached_read_tokens) AS cached, SUM(m.input_tokens + m.cache_write_tokens) AS uncached
       FROM llm_call_models m JOIN llm_calls c ON c.id = m.llm_call_id
       WHERE c.created_at >= @from AND c.created_at < @to
       GROUP BY c.provider_type, c.provider_id, m.model
       UNION ALL
       SELECT c.provider_type, c.provider_id, c.model, SUM(c.cached_read_tokens),
         SUM(c.input_tokens + c.cache_write_tokens)
       FROM llm_calls c
       WHERE c.created_at >= @from AND c.created_at < @to
         AND NOT EXISTS (SELECT 1 FROM llm_call_models m WHERE m.llm_call_id = c.id)
       GROUP BY c.provider_type, c.provider_id, c.model`,
    )
    .all({ from: from30, to }) as Array<{
    type: string
    providerId: string | null
    model: string
    cached: number | null
    uncached: number | null
  }>
  let savings = 0
  let cached = 0
  let prompt = 0
  for (const row of cacheRows) {
    const reads = row.cached ?? 0
    cached += reads
    prompt += reads + (row.uncached ?? 0)
    const price = reads > 0 ? prices(row.type, row.providerId, row.model) : null
    if (price) savings += (reads * Math.max(0, price.input - price.cacheRead)) / 1_000_000
  }
  const days = lastDays(now, chartDays)
  const daily = costs.summary({ from: startOfLocalDay(now, chartDays - 1), to, groupBy: 'day' })
  return {
    today: range(0),
    last7: range(6),
    last30: range(29),
    cacheSavingsUsd: savings,
    cachedShare: prompt > 0 ? cached / prompt : 0,
    days: fillDays(days, daily.rows),
  }
}
