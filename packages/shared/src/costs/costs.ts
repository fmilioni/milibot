import { z } from 'zod'

import { endpoint } from '../http/endpoint'
import { WorkspaceStatus } from '../workspace/workspace'

export const CostSource = z.enum(['provider', 'computed', 'unknown'])
export type CostSource = z.infer<typeof CostSource>

/**
 * Token buckets are disjoint: `inputTokens` excludes cache reads/writes and `outputTokens` excludes
 * reasoning, so providers that report inclusive totals must be normalized before storing.
 */
export const LlmCallUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  costSource: CostSource,
})
export type LlmCallUsage = z.infer<typeof LlmCallUsage>

/** The disjoint buckets of `LlmCallUsage`. */
export const TokenBuckets = z.object({
  inputTokens: z.number().int(),
  cachedReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  outputTokens: z.number().int(),
  reasoningTokens: z.number().int(),
})
export type TokenBuckets = z.infer<typeof TokenBuckets>

/** Usage of one model inside one LLM call (a Claude Code turn can use several models). */
export const LlmCallModelUsage = z.object({
  model: z.string(),
  ...TokenBuckets.shape,
  costUsd: z.number().nullable(),
  webSearchRequests: z.number().int(),
})
export type LlmCallModelUsage = z.infer<typeof LlmCallModelUsage>

export const CostGroupBy = z.enum(['bot', 'model', 'day'])
export type CostGroupBy = z.infer<typeof CostGroupBy>

const CostSummaryQuery = z.object({
  /** Epoch ms, inclusive; defaults to 30 days before `to`. */
  from: z.coerce.number().int().nonnegative().optional(),
  /** Epoch ms, exclusive; defaults to now. */
  to: z.coerce.number().int().nonnegative().optional(),
  groupBy: CostGroupBy.default('bot'),
})

export const CostTotals = z.object({
  costUsd: z.number(),
  ...TokenBuckets.shape,
  tokens: z.number().int(),
  /** LLM calls (a Claude Code turn is one call). */
  calls: z.number().int(),
})
export type CostTotals = z.infer<typeof CostTotals>

/**
 * Rows of `groupBy=bot` for LLM work done by Milibot itself rather than a bot's turn: group triage
 * (no bot), conversation summaries (billed to the bot whose memory they build), and the knowledge base's
 * document summaries and embeddings (API embedding models only).
 */
export const COST_SYSTEM_ROWS = {
  'system:triage': 'Group triage',
  'system:summaries': 'Memory summaries',
  'system:knowledge_summaries': 'Document summaries',
  'system:knowledge_index': 'Document index',
} as const satisfies Record<string, string>

export const CostSummaryRow = CostTotals.extend({
  /** Bot id (null = no bot), a `COST_SYSTEM_ROWS` key, model id, or local day `YYYY-MM-DD`. */
  key: z.string().nullable(),
  /** Bot name (or the synthetic row's label) for `groupBy=bot`; null otherwise. */
  label: z.string().nullable(),
})
export type CostSummaryRow = z.infer<typeof CostSummaryRow>

export const CostSummary = z.object({
  from: z.number().int(),
  to: z.number().int(),
  groupBy: CostGroupBy,
  totals: CostTotals,
  /** Sorted by cost (bot, model) or by day. */
  rows: z.array(CostSummaryRow),
})
export type CostSummary = z.infer<typeof CostSummary>

export const SpendStatus = z.object({
  /** Local `YYYY-MM-DD` the flags refer to. */
  day: z.string(),
  todayUsd: z.number().nonnegative(),
  warned: z.boolean(),
  /** Bots are held until tomorrow or until the user resumes them. */
  paused: z.boolean(),
  /** The user resumed today after a pause (the pause limit is ignored until tomorrow). */
  resumed: z.boolean(),
})
export type SpendStatus = z.infer<typeof SpendStatus>

export const CostPeriod = z.object({ costUsd: z.number(), tokens: z.number().int() })
export type CostPeriod = z.infer<typeof CostPeriod>

export const CostDay = z.object({ day: z.string(), ...CostPeriod.shape })
export type CostDay = z.infer<typeof CostDay>

const CostOverviewQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) })

export const CostOverview = z.object({
  today: CostPeriod,
  last7: CostPeriod,
  last30: CostPeriod,
  /** 30 days: what cache reads saved compared with paying full input price (models with known prices). */
  cacheSavingsUsd: z.number(),
  /** 30 days: cache reads / all prompt tokens (0..1). */
  cachedShare: z.number(),
  /** Oldest first, every day present (zero when idle); the last one is today. */
  days: z.array(CostDay),
})
export type CostOverview = z.infer<typeof CostOverview>

export const costEndpoints = {
  /** Cost and tokens in [from, to). */
  getCostSummary: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/costs/summary',
    query: CostSummaryQuery,
    response: CostSummary,
  }),
  /** Only moves the spend counter's start; history and cost summaries are kept. */
  resetUsageCounter: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/usage/reset-counter',
    response: WorkspaceStatus,
  }),
  getCostOverview: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/costs/overview',
    query: CostOverviewQuery,
    response: CostOverview,
  }),
  getSpendStatus: endpoint({ method: 'GET', path: '/w/:workspaceId/spend', response: SpendStatus }),
  /** Lets the bots work again after the daily pause limit held them. */
  resumeSpend: endpoint({ method: 'POST', path: '/w/:workspaceId/spend/resume', response: SpendStatus }),
}
