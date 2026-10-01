import type { EmbeddingModelCandidate, ProviderModel } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  activeLightModel,
  blankEmbeddingRow,
  blankRow,
  chatModelBody,
  cliProviderBody,
  decodeModelChoice,
  diffEmbeddingModels,
  diffModels,
  embeddingModelBody,
  embeddingRowFromModel,
  encodeModelChoice,
  formatHeaders,
  initialPicks,
  isOpenRouter,
  mergeEmbeddingCandidates,
  mergeFetched,
  parseHeaders,
  parsePrice,
  parseTokens,
  rowFromModel,
  suggestedLightModel,
  tokenInputText,
} from './provider-form'

const saved = (over: Partial<ProviderModel>): ProviderModel => ({
  id: 'pm_1',
  providerId: 'p',
  kind: 'chat',
  modelId: 'qwen3-coder-30b',
  displayName: 'Qwen3 Coder 30B',
  supportsTools: true,
  supportsVision: false,
  contextWindow: 128_000,
  maxOutputTokens: null,
  efforts: null,
  defaultEffort: null,
  dimensions: null,
  priceInputPerMtokUsd: 0,
  priceCacheReadPerMtokUsd: null,
  priceCacheWritePerMtokUsd: null,
  priceOutputPerMtokUsd: 0,
  pricePerRequestUsd: null,
  enabled: true,
  source: 'fetched',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const fetched = (modelId: string, over = {}) => ({
  modelId,
  displayName: modelId,
  supportsTools: true,
  supportsVision: true,
  contextWindow: 32_000,
  maxOutputTokens: null,
  efforts: null,
  defaultEffort: null,
  priceInputPerMtokUsd: null,
  priceOutputPerMtokUsd: null,
  priceCacheWritePerMtokUsd: null,
  priceCacheReadPerMtokUsd: null,
  ...over,
})

const candidate = (
  modelId: string,
  over: Partial<EmbeddingModelCandidate> = {},
): EmbeddingModelCandidate => ({
  modelId,
  displayName: modelId,
  description: null,
  contextWindow: null,
  priceInputPerMtokUsd: null,
  dimensions: null,
  embedding: true,
  suggested: false,
  ...over,
})

describe('provider form', () => {
  it('merges fetched models keeping switches, typed prices and manual rows', () => {
    const existing = rowFromModel(saved({ priceInputPerMtokUsd: 0.2, enabled: false }))
    const manual = { ...blankRow(), modelId: 'custom' }
    const rows = mergeFetched(
      [existing, manual],
      [fetched('qwen3-coder-30b', { priceOutputPerMtokUsd: 0.8 }), fetched('gemma-3-27b')],
    )
    expect(rows.map((r) => [r.modelId, r.enabled])).toEqual([
      ['qwen3-coder-30b', false],
      ['gemma-3-27b', false],
      ['custom', true],
    ])
    expect(rows[0]).toMatchObject({ id: 'pm_1', priceInputPerMtokUsd: 0.2, priceOutputPerMtokUsd: 0.8 })
    expect(mergeFetched([], [fetched('a')])[0]?.enabled).toBe(true)
  })

  it('keeps a renamed model when fetching again', () => {
    const renamed = { ...rowFromModel(saved({})), displayName: 'Coder' }
    expect(mergeFetched([renamed], [fetched('qwen3-coder-30b')])[0]?.displayName).toBe('Coder')
  })

  it('starts Anthropic and OpenRouter with Haiku as the light model, only while it is on', () => {
    const row = (modelId: string, enabled = true) => ({ ...blankRow(), modelId, enabled })
    expect(suggestedLightModel('anthropic', false, [])).toBe('claude-haiku-4-5')
    const haiku = row('anthropic/claude-haiku-4.5')
    expect(suggestedLightModel('openai_compatible', true, [row('x'), haiku])).toBe(
      'anthropic/claude-haiku-4.5',
    )
    expect(suggestedLightModel('openai_compatible', true, [{ ...haiku, enabled: false }])).toBeNull()
    expect(suggestedLightModel('openai_compatible', false, [haiku])).toBeNull()
  })

  it('drops the light model once its row is off or gone', () => {
    const flash = { ...blankRow(), modelId: 'flash' }
    expect(activeLightModel([flash], 'flash')).toBe('flash')
    expect(activeLightModel([{ ...flash, enabled: false }], 'flash')).toBeNull()
    expect(activeLightModel([], 'flash')).toBeNull()
    expect(activeLightModel([flash], null)).toBeNull()
  })

  it('diffs the table against the saved models', () => {
    const a = saved({ id: 'pm_a', modelId: 'a' })
    const b = saved({ id: 'pm_b', modelId: 'b' })
    const rows = [{ ...rowFromModel(a), enabled: false }, { ...blankRow(), modelId: 'c' }, { ...blankRow() }]
    const changes = diffModels([a, b], rows)
    expect(changes.create.map((r) => r.modelId)).toEqual(['c'])
    expect(changes.update.map((r) => r.id)).toEqual(['pm_a'])
    expect(changes.remove).toEqual(['pm_b'])
    expect(diffModels([a], [rowFromModel(a)])).toEqual({ create: [], update: [], remove: [] })
  })

  it('keeps fetched efforts and a chosen default, and saves effort changes', () => {
    const existing = { ...rowFromModel(saved({})), defaultEffort: 'high' as const }
    const [merged] = mergeFetched([existing], [fetched('qwen3-coder-30b', { efforts: ['low', 'high'] })])
    expect(merged).toMatchObject({ efforts: ['low', 'high'], defaultEffort: 'high' })
    const base = saved({ efforts: ['low', 'high'] })
    expect(diffModels([base], [{ ...rowFromModel(base), efforts: ['high', 'low'] }]).update).toHaveLength(0)
    expect(diffModels([base], [{ ...rowFromModel(base), efforts: ['low'] }]).update).toHaveLength(1)
    expect(chatModelBody({ ...rowFromModel(base), defaultEffort: 'low' })).toMatchObject({
      efforts: ['low', 'high'],
      defaultEffort: 'low',
    })
  })

  it('parses headers, prices and context sizes', () => {
    expect(parseHeaders('X-Org: acme; Authorization: Bearer x:y\nbad')).toEqual({
      'X-Org': 'acme',
      Authorization: 'Bearer x:y',
    })
    expect(formatHeaders({ 'X-Org': 'acme' })).toBe('X-Org: acme')
    expect(parsePrice('$0,80')).toBe(0.8)
    expect(parsePrice('')).toBeNull()
  })

  it('keeps a typed output cap unless the server reports one, and sends both limits', () => {
    const existing = { ...rowFromModel(saved({})), maxOutputTokens: 4096 }
    expect(mergeFetched([existing], [fetched('qwen3-coder-30b')])[0]?.maxOutputTokens).toBe(4096)
    expect(
      mergeFetched([existing], [fetched('qwen3-coder-30b', { maxOutputTokens: 65_536 })])[0]?.maxOutputTokens,
    ).toBe(65_536)
    const changed = diffModels([saved({})], [{ ...rowFromModel(saved({})), maxOutputTokens: 8000 }])
    expect(changed.update).toHaveLength(1)
    expect(chatModelBody(changed.update[0]!)).toMatchObject({
      kind: 'chat',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
    })
  })

  it('reads token counts the way people type them, and shows them compact', () => {
    expect(parseTokens('128k')).toBe(128_000)
    expect(parseTokens(' 1M ')).toBe(1_000_000)
    expect(parseTokens('1,5m')).toBe(1_500_000)
    expect(parseTokens('131072')).toBe(131_072)
    expect(parseTokens('32 768')).toBe(32_768)
    expect(parseTokens('8.192')).toBe(8192)
    expect(parseTokens('')).toBeNull()
    expect(parseTokens('lots')).toBeNull()
    expect(parseTokens('0')).toBeNull()
    expect([128_000, 1_000_000, 131_072, 1_048_576, 1_500_000, 950, null].map(tokenInputText)).toEqual([
      '128k',
      '1M',
      '131k',
      '1M',
      '1.5M',
      '950',
      '',
    ])
    for (const n of [128_000, 8000, 2_000_000]) expect(parseTokens(tokenInputText(n))).toBe(n)
  })
})

describe('embedding models table', () => {
  const savedEmbedding = (over: Partial<ProviderModel>) =>
    saved({
      kind: 'embedding',
      supportsTools: false,
      supportsVision: false,
      contextWindow: 32_768,
      ...over,
    })

  it('ticks what is registered, then the suggested (OpenRouter) or likely (other servers) models', () => {
    const list = [
      candidate('qwen/qwen3-embedding-4b', { suggested: true }),
      candidate('openai/text-embedding-3-small'),
      candidate('llama3', { embedding: false }),
    ]
    expect([...initialPicks(list, [], true)]).toEqual(['qwen/qwen3-embedding-4b'])
    const registered = embeddingRowFromModel(savedEmbedding({ modelId: 'openai/text-embedding-3-small' }))
    expect([...initialPicks(list, [registered], true)]).toEqual([
      'qwen/qwen3-embedding-4b',
      'openai/text-embedding-3-small',
    ])
    expect([...initialPicks(list, [], false)]).toEqual([
      'qwen/qwen3-embedding-4b',
      'openai/text-embedding-3-small',
    ])
  })

  it('adds picked models and refreshes the ones already there with what the server reports', () => {
    const existing = {
      ...embeddingRowFromModel(savedEmbedding({ id: 'pm_q', modelId: 'q', priceInputPerMtokUsd: 0.5 })),
      dimensions: 2560,
      enabled: false,
    }
    const rows = mergeEmbeddingCandidates(
      [existing],
      [
        candidate('q', { displayName: 'Qwen', priceInputPerMtokUsd: 0.02, contextWindow: null }),
        candidate('new', { contextWindow: 8192, priceInputPerMtokUsd: 0.1 }),
      ],
    )
    expect(rows).toMatchObject([
      {
        id: 'pm_q',
        displayName: 'Qwen',
        priceInputPerMtokUsd: 0.02,
        contextWindow: 32_768,
        dimensions: 2560,
        enabled: false,
      },
      {
        id: null,
        modelId: 'new',
        contextWindow: 8192,
        priceInputPerMtokUsd: 0.1,
        dimensions: null,
        enabled: true,
      },
    ])
  })

  it('diffs the table and sends embedding models with their measured size', () => {
    const a = savedEmbedding({ id: 'pm_a', modelId: 'a' })
    const b = savedEmbedding({ id: 'pm_b', modelId: 'b' })
    const rows = [
      { ...embeddingRowFromModel(a), dimensions: 1024 },
      { ...blankEmbeddingRow(), modelId: 'c' },
      blankEmbeddingRow(),
    ]
    const changes = diffEmbeddingModels([a, b], rows)
    expect(changes.create.map((r) => r.modelId)).toEqual(['c'])
    expect(changes.update.map((r) => r.id)).toEqual(['pm_a'])
    expect(changes.remove).toEqual(['pm_b'])
    expect(embeddingModelBody(changes.update[0]!)).toEqual({
      kind: 'embedding',
      modelId: 'a',
      displayName: 'Qwen3 Coder 30B',
      supportsTools: false,
      supportsVision: false,
      contextWindow: 32_768,
      priceInputPerMtokUsd: 0,
      dimensions: 1024,
      enabled: true,
    })
  })
})

describe('provider kinds', () => {
  it('recognizes OpenRouter by preset or URL', () => {
    expect(isOpenRouter({ preset: 'openrouter', baseUrl: null })).toBe(true)
    expect(isOpenRouter({ preset: null, baseUrl: 'https://openrouter.ai/api/v1' })).toBe(true)
    expect(isOpenRouter({ preset: null, baseUrl: 'http://10.0.0.2:1234/v1' })).toBe(false)
    expect(isOpenRouter({})).toBe(false)
  })

  it('adds a CLI engine with the subscription and its default model', () => {
    expect(cliProviderBody('claude_code')).toEqual({
      type: 'claude_code',
      name: 'Claude Code',
      authMode: 'subscription',
      defaultModel: 'sonnet',
    })
    expect(cliProviderBody('codex')).toEqual({
      type: 'codex',
      name: 'Codex',
      authMode: 'subscription',
      defaultModel: 'gpt-6.1-sol',
    })
  })
})

describe('model choice select values', () => {
  it('round-trips ids with separators and a missing model', () => {
    const choice = { providerId: 'provider_1', model: 'openai/gpt-4o:free' }
    expect(decodeModelChoice(encodeModelChoice(choice))).toEqual(choice)
    expect(decodeModelChoice(encodeModelChoice({ providerId: 'p', model: null }))).toEqual({
      providerId: 'p',
      model: null,
    })
    expect(encodeModelChoice(null)).toBe('')
    expect(decodeModelChoice('')).toBeNull()
  })
})
