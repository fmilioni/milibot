import { describe, expect, it } from 'vitest'

import type { CatalogProvider } from '../../../src/runtime/providers/catalog'
import {
  describeCatalog,
  parseContextLimit,
  resolveModelRequest,
} from '../../../src/runtime/providers/model-request'

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const catalog: CatalogProvider[] = [
  {
    provider: { id: 'or', type: 'openai_compatible', name: 'OpenRouter', preset: 'openrouter' },
    models: [
      {
        modelId: 'openai/gpt-5',
        displayName: 'GPT-5',
        contextWindow: 400_000,
        efforts: ['low', 'medium', 'high'],
      },
      { modelId: 'openai/gpt-5-mini', displayName: 'GPT-5 mini', contextWindow: 400_000, efforts: null },
      {
        modelId: 'anthropic/claude-opus-4-8',
        displayName: 'Claude Opus 4.8',
        contextWindow: 1_000_000,
        efforts: [...ALL],
      },
      {
        modelId: 'anthropic/claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        contextWindow: 1_000_000,
        efforts: [...ALL],
      },
      {
        modelId: 'anthropic/claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        contextWindow: 1_000_000,
        efforts: [...ALL],
      },
      { modelId: 'a/grok-4', displayName: 'Grok 4', contextWindow: 256_000, efforts: null },
      { modelId: 'b/grok-4', displayName: 'Grok 4', contextWindow: 256_000, efforts: null },
      {
        modelId: 'anthropic/claude-sonnet-5:beta',
        displayName: 'Claude Sonnet 5 beta',
        contextWindow: 1_000_000,
        efforts: [...ALL],
      },
    ],
  },
  {
    provider: { id: 'cc', type: 'claude_code', name: 'Claude Code', preset: null },
    models: [
      { modelId: 'opus', displayName: 'Opus', contextWindow: 1_000_000, efforts: [...ALL] },
      { modelId: 'haiku', displayName: 'Haiku', contextWindow: 200_000, efforts: [] },
    ],
  },
]

describe('resolveModelRequest', () => {
  it('finds the newest model with the fewest other words, on the first provider that has one', () => {
    const r = resolveModelRequest(catalog, { model: 'claude opus', effort: 'high' })
    expect(r).toMatchObject({
      ok: true,
      choice: { providerId: 'or', model: 'anthropic/claude-opus-5-5', effort: 'high', contextLimit: null },
    })
    expect(resolveModelRequest(catalog, { model: 'gpt 5' })).toMatchObject({
      choice: { model: 'openai/gpt-5' },
    })
    expect(resolveModelRequest(catalog, { model: 'opus 4.8' })).toMatchObject({
      choice: { model: 'anthropic/claude-opus-4-8' },
    })
  })

  it('goes where the user said and takes exact ids (Claude Code aliases) anywhere', () => {
    expect(resolveModelRequest(catalog, { model: 'opus' })).toMatchObject({ choice: { providerId: 'cc' } })
    expect(resolveModelRequest(catalog, { model: 'opus', provider: 'openrouter' })).toMatchObject({
      choice: { providerId: 'or', model: 'anthropic/claude-opus-5-5' },
    })
    expect(resolveModelRequest(catalog, { model: 'opus', provider: 'claude code' })).toMatchObject({
      choice: { providerId: 'cc', model: 'opus' },
    })
    expect(resolveModelRequest(catalog, { model: 'haiku' })).toMatchObject({ choice: { providerId: 'cc' } })
    expect(resolveModelRequest(catalog, { model: 'nope', provider: 'gemini' })).toMatchObject({ ok: false })
  })

  it('reports ambiguous and unknown names with what exists', () => {
    expect(resolveModelRequest(catalog, { model: 'sonnet' })).toMatchObject({
      choice: { model: 'anthropic/claude-sonnet-5' },
    })
    const ambiguous = resolveModelRequest(catalog, { model: 'grok' })
    expect(ambiguous).toMatchObject({ ok: false, error: expect.stringContaining('several') })
    const unknown = resolveModelRequest(catalog, { model: 'gemini' })
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining('GPT-5') })
  })

  it('narrows the effort to what the model accepts and explains it', () => {
    const r = resolveModelRequest(catalog, { model: 'openai/gpt-5', effort: 'max' })
    expect(r).toMatchObject({
      ok: true,
      choice: { effort: 'high' },
      notes: [expect.stringContaining('high')],
    })
    const none = resolveModelRequest(catalog, { model: 'haiku', effort: 'high' })
    expect(none).toMatchObject({ ok: true, choice: { effort: null } })
    expect(resolveModelRequest(catalog, { model: 'opus', effort: 'turbo' })).toMatchObject({ ok: false })

    const custom: CatalogProvider[] = [
      {
        provider: { id: 'local', type: 'openai_compatible', name: 'Local', preset: null },
        models: [{ modelId: 'qwen', displayName: 'Qwen', contextWindow: 256_000, efforts: ['low', 'Turbo'] }],
      },
    ]
    expect(resolveModelRequest(custom, { model: 'qwen', effort: 'turbo' })).toMatchObject({
      ok: true,
      choice: { effort: 'Turbo' },
    })
    expect(resolveModelRequest(custom, { model: 'qwen', effort: 'max' })).toMatchObject({
      ok: true,
      choice: { effort: 'low' },
    })
    expect(resolveModelRequest(custom, { model: 'qwen', effort: 'ultra' })).toMatchObject({ ok: false })
  })

  it('takes a context limit below the window and ignores one that is not', () => {
    expect(resolveModelRequest(catalog, { model: 'opus', context: '256k' })).toMatchObject({
      choice: { contextLimit: 256_000 },
    })
    expect(resolveModelRequest(catalog, { model: 'opus [1m]' })).toMatchObject({
      choice: { contextLimit: null },
    })
    expect(resolveModelRequest(catalog, { model: 'haiku', context: '1m' })).toMatchObject({
      ok: true,
      choice: { contextLimit: null },
      notes: [expect.stringContaining('200000')],
    })
    expect(resolveModelRequest(catalog, { model: 'opus', context: 'lots' })).toMatchObject({ ok: false })
  })
})

describe('parseContextLimit', () => {
  it('reads tokens, k and m', () => {
    expect(parseContextLimit('256k')).toBe(256_000)
    expect(parseContextLimit('1M')).toBe(1_000_000)
    expect(parseContextLimit('1.5m')).toBe(1_500_000)
    expect(parseContextLimit(200_000)).toBe(200_000)
    expect(parseContextLimit('')).toBeNull()
    expect(parseContextLimit('big')).toBe('invalid')
  })
})

describe('describeCatalog', () => {
  it('lists each provider with context and efforts, filtered by a query', () => {
    const text = describeCatalog(catalog, 'haiku')
    expect(text).toContain('Claude Code (claude_code):')
    expect(text).toContain('- haiku — Haiku; 200k context; no effort')
    expect(text).not.toContain('OpenRouter')
  })
})
