import { describe, expect, it } from 'vitest'

import {
  embeddingOptions,
  isLoopbackUrl,
  probeRegisteredEmbedding,
} from '../../../src/runtime/embeddings/options'
import { ProviderStore } from '../../../src/runtime/providers/store'
import { MemorySecretStore } from '../../../src/secrets/secret-store'
import { knowledgeTest } from '../knowledge/fixtures'

const t = knowledgeTest()

describe('embedding options', () => {
  it('lists the local catalog and the registered, enabled embedding models, without fetching', async () => {
    const providers = new ProviderStore({ db: t.db, workspaceId: 'ws', secrets: new MemorySecretStore() })
    const openrouter = await providers.create({
      type: 'openai_compatible',
      name: 'OpenRouter',
      preset: 'openrouter',
      apiKey: 'sk-or',
    })
    await providers.create({ type: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant' })
    providers.createModel(openrouter.id, { modelId: 'anthropic/claude-haiku-4.5', priceInputPerMtokUsd: 1 })
    providers.createModel(openrouter.id, {
      kind: 'embedding',
      modelId: 'qwen/qwen3-embedding-8b',
      displayName: 'Qwen: Qwen3 Embedding 8B',
      contextWindow: 32_768,
      priceInputPerMtokUsd: 0.01,
    })
    providers.createModel(openrouter.id, {
      kind: 'embedding',
      modelId: 'openai/text-embedding-3-small',
      priceInputPerMtokUsd: 0.02,
      dimensions: 1536,
      enabled: false,
    })
    const options = await embeddingOptions({
      current: { provider: 'local', family: 'embeddinggemma', level: 'max' },
      modelsDir: null,
      download: null,
      providers,
    })
    expect(options.local.map((f) => f.id)).toEqual(['embeddinggemma', 'multilingual-e5'])
    expect(options.local.flatMap((f) => f.levels).filter((l) => l.recommended)).toHaveLength(1)
    expect(options.api).toEqual([
      {
        providerId: openrouter.id,
        name: 'OpenRouter',
        preset: 'openrouter',
        local: false,
        models: [
          {
            model: 'qwen/qwen3-embedding-8b',
            name: 'Qwen: Qwen3 Embedding 8B',
            dimensions: null,
            maxInputTokens: 32_768,
            priceInputPerMtokUsd: 0.01,
          },
        ],
      },
    ])
  })

  it('probes a registered model and stores its size; unregistered models are refused', async () => {
    const providers = new ProviderStore({ db: t.db, workspaceId: 'ws', secrets: new MemorySecretStore() })
    const local = await providers.create({
      type: 'openai_compatible',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
    })
    providers.createModel(local.id, { kind: 'embedding', modelId: 'nomic-embed-text' })
    const bodies: unknown[] = []
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }))
    }) as typeof fetch
    expect(
      await probeRegisteredEmbedding({
        providers,
        providerId: local.id,
        model: 'nomic-embed-text',
        fetch: fakeFetch,
      }),
    ).toEqual({ ok: true, dimensions: 3, errorCode: null, error: null })
    expect(bodies[0]).toMatchObject({ model: 'nomic-embed-text', input: ['dimension probe'] })
    expect(providers.embeddingModel(local.id, 'nomic-embed-text')?.dimensions).toBe(3)
    expect(
      await probeRegisteredEmbedding({ providers, providerId: local.id, model: 'other', fetch: fakeFetch }),
    ).toMatchObject({ ok: false, errorCode: 'model_not_found' })
    expect(bodies).toHaveLength(1)
  })

  it('tells providers on this computer apart', () => {
    expect(
      ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1'].map(isLoopbackUrl),
    ).toEqual([true, true, true])
    expect(
      ['http://192.168.0.20:1234/v1', 'https://openrouter.ai/api/v1', null, 'nope'].map(isLoopbackUrl),
    ).toEqual([false, false, false, false])
  })
})
