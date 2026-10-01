import { describe, expect, it } from 'vitest'

import { testProviders } from '../../support/providers'

describe('ProviderStore', () => {
  it('knows which providers exist', async () => {
    const { store: providers } = testProviders()
    const anthropic = await providers.create({ type: 'anthropic', name: 'Anthropic', apiKey: 'k' })
    expect(providers.exists(anthropic.id)).toBe(true)
    expect(providers.exists('prv_missing')).toBe(false)
  })

  it('keeps chat and embedding models apart, even with the same id', async () => {
    const { store: providers } = testProviders()
    const p = await providers.create({ type: 'openai_compatible', name: 'LM Studio', baseUrl: 'http://x/v1' })
    providers.createModel(p.id, { kind: 'embedding', modelId: 'nomic-embed', priceInputPerMtokUsd: 0.5 })
    providers.createModel(p.id, { modelId: 'nomic-embed', priceInputPerMtokUsd: 3 })
    providers.createModel(p.id, { modelId: 'qwen3-8b' })
    expect(providers.listModels(p.id).map((m) => [m.modelId, m.kind])).toEqual([
      ['nomic-embed', 'chat'],
      ['qwen3-8b', 'chat'],
    ])
    expect(providers.listModels(p.id, 'embedding')).toMatchObject([
      { modelId: 'nomic-embed', kind: 'embedding', priceInputPerMtokUsd: 0.5, supportsTools: false },
    ])
    const embedding = providers.listModels(p.id, 'embedding')[0]!
    expect(providers.updateModel(p.id, embedding.id, { dimensions: 768 })).toMatchObject({
      kind: 'embedding',
      dimensions: 768,
    })
    // A re-fetch without a size keeps the measured one.
    providers.createModel(p.id, { kind: 'embedding', modelId: 'nomic-embed', priceInputPerMtokUsd: 0.4 })
    expect(providers.listModels(p.id, 'embedding')[0]).toMatchObject({
      dimensions: 768,
      priceInputPerMtokUsd: 0.4,
    })
    providers.deleteModel(p.id, 'nomic-embed')
    expect(providers.listModels(p.id).map((m) => m.modelId)).toEqual(['qwen3-8b'])
    expect(providers.listModels(p.id, 'embedding')).toHaveLength(1)
  })

  it('adds suggested embedding models without touching the ones already registered', async () => {
    const { store: providers } = testProviders()
    const p = await providers.create({ type: 'openai_compatible', name: 'OpenRouter', preset: 'openrouter' })
    providers.createModel(p.id, {
      kind: 'embedding',
      modelId: 'qwen/qwen3-embedding-4b',
      priceInputPerMtokUsd: 9,
    })
    const models = providers.addEmbeddingModels(p.id, [
      { modelId: 'qwen/qwen3-embedding-4b', priceInputPerMtokUsd: 0.02 },
      { modelId: 'qwen/qwen3-embedding-8b', priceInputPerMtokUsd: 0.01, contextWindow: 32_768 },
    ])
    expect(models.map((m) => [m.modelId, m.priceInputPerMtokUsd, m.source])).toEqual([
      ['qwen/qwen3-embedding-4b', 9, 'manual'],
      ['qwen/qwen3-embedding-8b', 0.01, 'fetched'],
    ])
  })
})
