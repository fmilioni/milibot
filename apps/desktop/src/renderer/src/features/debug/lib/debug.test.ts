import type { DebugTurn, LlmCallRow } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  callTone,
  formatCost,
  formatLatency,
  purposeBadge,
  shortModel,
  toolResultText,
  turnRows,
} from './debug'

function call(partial: Partial<LlmCallRow> & { id: string; createdAt: number }): LlmCallRow {
  return {
    botId: 'bot_a',
    conversationId: 'cnv_1',
    turnId: null,
    purpose: 'turn',
    providerId: 'prv',
    providerType: 'anthropic',
    model: 'claude-sonnet-5',
    request: null,
    response: null,
    inputTokens: 100,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    costUsd: 0.01,
    costSource: 'computed',
    contextComposition: null,
    stopReason: 'end_turn',
    generationId: null,
    latencyMs: 1000,
    error: null,
    ...partial,
  }
}

describe('debug data shaping', () => {
  const nbsp = (text: string) => text.replace(/\u00a0/g, ' ')

  it('formats costs and latencies, with a dash when unknown', () => {
    expect(nbsp(formatCost(0.17, 'pt-BR'))).toBe('US$ 0,170')
    expect(formatCost(1.844, 'en')).toBe('$1.84')
    expect(formatCost(null, 'en')).toBe('—')
    expect(formatLatency(900, 'pt-BR')).toBe('0,9s')
    expect(formatLatency(null, 'en')).toBe('—')
  })

  it('shortens model ids', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(shortModel('anthropic/claude-sonnet-4.5')).toBe('Sonnet 4.5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(shortModel('sonnet')).toBe('Sonnet')
    expect(shortModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(shortModel('gpt-4o')).toBe('gpt-4o')
  })

  it('derives the tone of a call', () => {
    expect(callTone({ error: null, stopReason: 'end_turn' })).toBe('ok')
    expect(callTone({ error: '429 Too Many Requests', stopReason: 'error' })).toBe('error')
    expect(callTone({ error: null, stopReason: 'end_turn', retries: 1 })).toBe('retried')
    expect(callTone({ error: null, stopReason: 'max_tokens' })).toBe('limit')
    expect(purposeBadge('turn')).toBeNull()
    expect(purposeBadge('summary_merge')).toBe('summary')
  })

  it('makes one row per turn and per call outside turns, newest first', () => {
    const turns: DebugTurn[] = [
      {
        turnId: 't1',
        botId: 'bot_a',
        startedAt: 10,
        calls: 3,
        costUsd: 0.05,
        tokens: 0,
        trigger: { messageId: 'm', authorType: 'user', authorBotId: null, snippet: 'hi' },
      },
    ]
    const rows = turnRows(
      [
        call({ id: 'c3', createdAt: 3000, turnId: 't2', latencyMs: 500 }),
        call({ id: 'c1', createdAt: 1000, turnId: 't1', latencyMs: 400, error: '429 rate limit' }),
        call({ id: 'c0', createdAt: 500, purpose: 'triage', botId: null, model: 'claude-haiku-4-5' }),
        call({ id: 'c2', createdAt: 2000, turnId: 't1', latencyMs: 700, model: 'claude-haiku-4-5' }),
        call({ id: 'c4', createdAt: 4000, purpose: 'summary', costUsd: null }),
      ],
      turns,
    )
    expect(rows.map((r) => [r.key, r.calls.map((c) => c.id), r.badge])).toEqual([
      ['call:c4', ['c4'], 'summary'],
      ['t2', ['c3'], null],
      ['t1', ['c2', 'c1'], null],
      ['call:c0', ['c0'], 'triage'],
    ])
    const t1 = rows[2]!
    expect(t1.tone).toBe('retried')
    expect(t1.error).toBe('429 rate limit')
    expect(t1.costUsd).toBeCloseTo(0.05)
    expect(t1.latencyMs).toBe(2000 - (1000 - 400))
    expect(t1.tokens).toMatchObject({ input: 200, output: 20, total: 220 })
    expect(t1.models).toEqual(['claude-sonnet-5', 'claude-haiku-4-5'])
    expect(rows[0]?.costUsd).toBeNull()
  })

  it('reads tool result text', () => {
    expect(toolResultText({ isError: false, text: 'hello' })).toBe('hello')
    expect(toolResultText(null)).toBe('')
  })
})
