import { describe, expect, it } from 'vitest'

import {
  API_EMBEDDING_MODELS,
  defaultEmbeddingSetting,
  findLocalEmbeddingLevel,
  LOCAL_EMBEDDING_FAMILIES,
  localEmbeddingLevels,
  localEmbeddingSpaceKey,
  localSettingSpaceKey,
  onnxModelFiles,
  recommendedLocalEmbeddingLevel,
} from './catalog'
import { createEmbeddingProvider, parseEmbeddingSetting } from './factory'
import { FakeEmbeddingProvider } from './fake'
import { LocalEmbeddingProvider } from './local'
import { cosine } from './vector'

describe('embedding catalog', () => {
  it('has the six local levels with unique space keys and one recommended level', () => {
    const levels = localEmbeddingLevels()
    expect(levels.map((l) => `${l.family}/${l.id}/${l.dimensions}`)).toEqual([
      'embeddinggemma/max/768',
      'embeddinggemma/balanced/512',
      'embeddinggemma/compact/256',
      'multilingual-e5/small/384',
      'multilingual-e5/base/768',
      'multilingual-e5/large/1024',
    ])
    expect(new Set(levels.map(localEmbeddingSpaceKey)).size).toBe(levels.length)
    expect(levels.filter((l) => l.recommended)).toHaveLength(1)
    expect(recommendedLocalEmbeddingLevel()).toMatchObject({ family: 'embeddinggemma', id: 'max' })
  })

  it('describes every model completely', () => {
    for (const level of localEmbeddingLevels()) {
      const { model } = level
      expect(level.dimensions).toBeLessThanOrEqual(model.nativeDimensions)
      expect(level.ramMb).toBeGreaterThan(0)
      expect(model.downloadBytes).toBeGreaterThan(50_000_000)
      expect(model.files).toContain('tokenizer.json')
      expect(model.files.some((f) => f.startsWith('onnx/') && f.endsWith('.onnx'))).toBe(true)
      expect(model.batchTokens).toBeGreaterThanOrEqual(model.maxInputTokens)
    }
    const family = (id: string) => LOCAL_EMBEDDING_FAMILIES.find((f) => f.id === id)!
    // EmbeddingGemma's Matryoshka sizes; its own prompts; pooled output of the graph.
    for (const level of family('embeddinggemma').levels) {
      expect([768, 512, 256, 128]).toContain(level.dimensions)
      expect(level.model.queryPrefix).toBe('task: search result | query: ')
      expect(level.model.documentPrefix).toBe('title: none | text: ')
      expect(level.model.pooling).toBe('model')
    }
    for (const level of family('multilingual-e5').levels) {
      expect(level.dimensions).toBe(level.model.nativeDimensions)
      expect([level.model.queryPrefix, level.model.documentPrefix]).toEqual(['query: ', 'passage: '])
      expect(level.model.pooling).toBe('mean')
    }
  })

  it('maps dtypes to the ONNX files transformers.js loads', () => {
    expect(onnxModelFiles('q8', false)).toContain('onnx/model_quantized.onnx')
    expect(onnxModelFiles('q4', true)).toEqual(
      expect.arrayContaining(['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data']),
    )
    expect(onnxModelFiles('fp32', false)).toContain('onnx/model.onnx')
  })

  it('knows the Qwen3 models offered through OpenRouter', () => {
    expect(API_EMBEDDING_MODELS.map((m) => m.model)).toEqual([
      'qwen/qwen3-embedding-4b',
      'qwen/qwen3-embedding-8b',
    ])
  })

  it('resolves settings, falling back to the default for anything invalid', () => {
    expect(defaultEmbeddingSetting()).toEqual({ provider: 'local', family: 'embeddinggemma', level: 'max' })
    expect(parseEmbeddingSetting({ provider: 'local', family: 'multilingual-e5', level: 'base' })).toEqual({
      provider: 'local',
      family: 'multilingual-e5',
      level: 'base',
    })
    expect(parseEmbeddingSetting({ provider: 'api', providerId: 'p', model: 'm' })).toEqual({
      provider: 'api',
      providerId: 'p',
      model: 'm',
    })
    for (const bad of [
      null,
      'gemma',
      { provider: 'local', family: 'embeddinggemma', level: 'huge' },
      { provider: 'api' },
    ]) {
      expect(parseEmbeddingSetting(bad)).toEqual(defaultEmbeddingSetting())
    }
    expect(localSettingSpaceKey({ provider: 'local', family: 'multilingual-e5', level: 'small' })).toBe(
      'local:multilingual-e5-small:q8:384',
    )
    expect(localSettingSpaceKey({ provider: 'api', providerId: 'p', model: 'm' })).toBeNull()
    expect(findLocalEmbeddingLevel('embeddinggemma', 'nope')).toBeNull()
  })
})

describe('createEmbeddingProvider', () => {
  it('builds local providers without starting the model', async () => {
    const provider = await createEmbeddingProvider(
      { provider: 'local', family: 'multilingual-e5', level: 'large' },
      { local: { cacheDir: '/nonexistent/milibot-factory' } },
    )
    expect(provider).toBeInstanceOf(LocalEmbeddingProvider)
    expect(provider.key).toBe('local:multilingual-e5-large:q8:1024')
    await provider.dispose?.()
  })

  it('builds API providers through the resolver', async () => {
    const provider = await createEmbeddingProvider(
      { provider: 'api', providerId: 'provider_x', model: 'qwen/qwen3-embedding-8b', dimensions: 1024 },
      {
        local: { cacheDir: '/nonexistent' },
        resolveApi: async (setting) => ({
          providerId: setting.providerId,
          model: setting.model,
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'k',
        }),
      },
    )
    expect(provider.key).toBe('api:provider_x:qwen/qwen3-embedding-8b:1024')
    expect(provider.dimensions).toBe(1024)
  })

  it('rejects unknown local levels and API settings without a resolver', async () => {
    await expect(
      createEmbeddingProvider(
        { provider: 'local', family: 'embeddinggemma', level: 'huge' },
        { local: { cacheDir: '/nonexistent' } },
      ),
    ).rejects.toMatchObject({ code: 'invalid_setting' })
    await expect(
      createEmbeddingProvider(
        { provider: 'api', providerId: 'p', model: 'm' },
        { local: { cacheDir: '/x' } },
      ),
    ).rejects.toMatchObject({ code: 'invalid_setting' })
  })
})

describe('FakeEmbeddingProvider', () => {
  it('is deterministic, accent/case-insensitive and closer for texts sharing words', async () => {
    const fake = new FakeEmbeddingProvider({ dimensions: 128, pricePerMtokUsd: 1 })
    const [a, b, c, d] = (
      await fake.embed(
        ['Payment terms of the contract', 'PAYMENT TERMS', 'carrot cake recipe', 'payment terms'],
        'document',
      )
    ).vectors
    expect(fake.key).toBe('fake:hash:128')
    expect(Array.from(b!)).toEqual(Array.from(d!))
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!))
    expect(Math.hypot(...a!)).toBeCloseTo(1, 5)
    expect(fake.calls).toEqual([{ texts: expect.any(Array), kind: 'document' }])
    const res = await fake.embed(['', 'x'], 'query')
    expect(Math.hypot(...res.vectors[0]!)).toBeCloseTo(1, 5)
    expect(res.usage!.costUsd).toBeGreaterThan(0)
  })
})
