import type { LlmCallRecord } from '@milibot/agent'
import { USAGE_COUNTER_RESET_KEY } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { CostStore, fillDays, lastDays } from '../../../src/runtime/observability/cost'
import { LlmCallStore } from '../../../src/runtime/observability/llm-calls'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

const DAY = 24 * 60 * 60 * 1000

function setup() {
  const db = openWorkspaceDb(':memory:')
  let clock = new Date(2026, 8, 20, 10, 0).getTime()
  const now = () => clock
  const store = new WorkspaceStore(db, now)
  const llmCalls = new LlmCallStore(db, now)
  const costs = new CostStore(db, now)
  const ana = store.bots.create({ name: 'Ana' })
  const leo = store.bots.create({ name: 'Leo' })
  const record = (over: Partial<LlmCallRecord>): LlmCallRecord => ({
    botId: ana.id,
    conversationId: null,
    turnId: null,
    purpose: 'turn',
    providerId: null,
    providerType: 'claude_code',
    model: 'claude-sonnet-5',
    request: null,
    response: null,
    usage: {
      inputTokens: 10,
      cachedReadTokens: 1000,
      cacheWriteTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      costUsd: 0.5,
      costSource: 'provider',
    },
    contextComposition: null,
    stopReason: null,
    generationId: null,
    latencyMs: null,
    error: null,
    ...over,
  })
  const at = (ms: number) => {
    clock = ms
  }
  return { db, store, llmCalls, costs, ana, leo, record, at, start: clock }
}

const usage = (model: string, costUsd: number, cachedReadTokens: number) => ({
  model,
  inputTokens: 5,
  cachedReadTokens,
  cacheWriteTokens: 50,
  outputTokens: 25,
  reasoningTokens: 0,
  costUsd,
  webSearchRequests: 0,
})

describe('cost summary', () => {
  it('aggregates by bot, by model (with the Claude Code breakdown) and by local day', () => {
    const { llmCalls, costs, ana, leo, record, at, start } = setup()
    llmCalls.insert(
      record({ models: [usage('claude-sonnet-5', 0.4, 900), usage('claude-haiku-4-5', 0.1, 100)] }),
    )
    at(start + DAY)
    llmCalls.insert(
      record({
        botId: leo.id,
        providerType: 'openai_compatible',
        model: 'anthropic/claude-haiku-4.5',
        usage: { ...record({}).usage, costUsd: 0.25, costSource: 'provider' },
      }),
    )
    at(start + 40 * DAY)
    llmCalls.insert(record({ usage: { ...record({}).usage, costUsd: 9 } }))

    const range = { from: start - DAY, to: start + 2 * DAY }
    const byBot = costs.summary({ ...range, groupBy: 'bot' })
    expect(byBot.totals).toMatchObject({ costUsd: 0.75, calls: 2, tokens: 2 * 1160 })
    expect(byBot.rows.map((r) => [r.key, r.label, r.costUsd, r.calls])).toEqual([
      [ana.id, 'Ana', 0.5, 1],
      [leo.id, 'Leo', 0.25, 1],
    ])

    const byModel = costs.summary({ ...range, groupBy: 'model' })
    expect(byModel.rows.map((r) => [r.key, r.costUsd, r.cachedReadTokens])).toEqual([
      ['claude-sonnet-5', 0.4, 900],
      ['anthropic/claude-haiku-4.5', 0.25, 1000],
      ['claude-haiku-4-5', 0.1, 100],
    ])

    const byDay = costs.summary({ ...range, groupBy: 'day' })
    expect(byDay.rows.map((r) => [r.key, r.costUsd])).toEqual([
      ['2026-09-20', 0.5],
      ['2026-09-21', 0.25],
    ])
    // Default range: the last 30 days.
    expect(costs.summary({ groupBy: 'bot' }).totals.costUsd).toBe(9)
  })

  it('groups triage and memory summaries under synthetic rows instead of bots', () => {
    const { llmCalls, costs, ana, record } = setup()
    llmCalls.insert(record({}))
    llmCalls.insert(record({ botId: null, purpose: 'triage' }))
    llmCalls.insert(record({ botId: null, purpose: 'triage' }))
    llmCalls.insert(record({ purpose: 'summary', usage: { ...record({}).usage, costUsd: 0.2 } }))
    llmCalls.insert(record({ purpose: 'summary_merge', usage: { ...record({}).usage, costUsd: 0.1 } }))

    const rows = costs.summary({ groupBy: 'bot' }).rows.map((r) => [r.key, r.label, r.costUsd, r.calls])
    expect(rows).toEqual([
      ['system:triage', 'Group triage', 1, 2],
      [ana.id, 'Ana', 0.5, 1],
      ['system:summaries', 'Memory summaries', expect.closeTo(0.3), 2],
    ])
  })

  it('lists the per-model breakdown with the llm call', () => {
    const { llmCalls, record, store } = setup()
    const conversation = store.conversations.create({ type: 'direct', botIds: [store.bots.list()[0]!.id] })
    llmCalls.insert(record({ conversationId: conversation.id, models: [usage('claude-sonnet-5', 0.4, 900)] }))
    const [call] = llmCalls.list(conversation.id, { limit: 10 })
    expect(call?.models).toEqual([usage('claude-sonnet-5', 0.4, 900)])
  })
})

describe('footer spend counter', () => {
  it('counts since midnight, or since the last reset made today', () => {
    const { store, llmCalls, record, at, start } = setup()
    const spend = (now: number) =>
      llmCalls.usageStatus(now, store.settings.get<number | null>(USAGE_COUNTER_RESET_KEY, null))
    llmCalls.insert(record({}))
    at(start + 60_000)
    expect(spend(start + 60_000).usageCounter).toMatchObject({ reset: false, costUsd: 0.5 })
    store.settings.set(USAGE_COUNTER_RESET_KEY, start + 60_000)
    at(start + 120_000)
    llmCalls.insert(record({ usage: { ...record({}).usage, costUsd: 0.1 } }))
    const status = spend(start + 180_000)
    expect(status.usageToday.costUsd).toBeCloseTo(0.6)
    expect(status.usageCounter).toMatchObject({
      reset: true,
      since: start + 60_000,
      costUsd: 0.1,
      tokens: 1160,
    })
    // A reset from an earlier day no longer applies.
    expect(spend(start + DAY).usageCounter).toMatchObject({ reset: false })
  })
})

describe('cost overview', () => {
  function overviewSetup() {
    const db = openWorkspaceDb(':memory:')
    let clock = new Date(2026, 8, 26, 15, 0).getTime()
    const store = new WorkspaceStore(db, () => clock)
    const llmCalls = new LlmCallStore(db, () => clock)
    const bot = store.bots.create({ name: 'Ana' })
    const call = (at: number, cost: number, cachedRead: number) => {
      clock = at
      llmCalls.insert({
        botId: bot.id,
        conversationId: null,
        turnId: null,
        purpose: 'turn',
        providerId: null,
        providerType: 'anthropic',
        model: 'claude-sonnet-4-5',
        request: null,
        response: null,
        usage: {
          inputTokens: 100,
          cachedReadTokens: cachedRead,
          cacheWriteTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
          costUsd: cost,
          costSource: 'provider',
        },
        contextComposition: null,
        stopReason: null,
        generationId: null,
        latencyMs: null,
        error: null,
      } satisfies LlmCallRecord)
    }
    const now = new Date(2026, 8, 26, 15, 0).getTime()
    return { costs: new CostStore(db, () => now), call, now }
  }

  it('lists every day of the chart, oldest first, ending today', () => {
    const now = new Date(2026, 8, 26, 15, 0).getTime()
    const days = lastDays(now, 14)
    expect(days).toHaveLength(14)
    expect(days[0]).toBe('2026-09-13')
    expect(days.at(-1)).toBe('2026-09-26')
    expect(lastDays(new Date(2026, 2, 2, 1, 0).getTime(), 3)).toEqual([
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ])
    expect(fillDays(['2026-09-25', '2026-09-26'], [{ key: '2026-09-26', costUsd: 2, tokens: 10 }])).toEqual([
      { day: '2026-09-25', costUsd: 0, tokens: 0 },
      { day: '2026-09-26', costUsd: 2, tokens: 10 },
    ])
  })

  it('sums today, 7 and 30 days, the daily chart and the cache savings', () => {
    const { costs, call, now } = overviewSetup()
    call(now - 40 * DAY, 100, 0)
    call(now - 20 * DAY, 3, 0)
    call(now - 3 * DAY, 2, 1_000_000)
    call(now - 60_000, 1.5, 0)
    const overview = costs.overview(14, (type, _providerId, model) =>
      type === 'anthropic' && model.startsWith('claude-sonnet') ? { input: 3, cacheRead: 0.3 } : null,
    )
    expect(overview.today.costUsd).toBeCloseTo(1.5)
    expect(overview.last7.costUsd).toBeCloseTo(3.5)
    expect(overview.last30.costUsd).toBeCloseTo(6.5)
    expect(overview.days).toHaveLength(14)
    expect(overview.days.at(-1)).toMatchObject({ day: '2026-09-26', costUsd: 1.5 })
    expect(overview.days.at(-4)).toMatchObject({ day: '2026-09-23', costUsd: 2 })
    expect(overview.days.filter((d) => d.costUsd > 0)).toHaveLength(2)
    expect(overview.cacheSavingsUsd).toBeCloseTo(2.7)
    expect(overview.cachedShare).toBeCloseTo(1_000_000 / (1_000_000 + 300))
  })
})
