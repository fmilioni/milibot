import { describe, expect, it } from 'vitest'

import { testProviders } from '../../support/providers'

describe('ProviderClients.embeddingApiOptions', () => {
  it('builds the connection from the registered model: price, dimensions and longest input', async () => {
    const { store: providers, clients } = testProviders()
    const openrouter = await providers.create({
      type: 'openai_compatible',
      name: 'OpenRouter',
      preset: 'openrouter',
      apiKey: 'sk-or',
      extraHeaders: { 'x-extra': '1' },
    })
    providers.createModel(openrouter.id, {
      kind: 'embedding',
      modelId: 'qwen/qwen3-embedding-4b',
      priceInputPerMtokUsd: 0.02,
      contextWindow: 32_768,
      dimensions: 2560,
    })
    expect(await clients.embeddingApiOptions(openrouter.id, 'qwen/qwen3-embedding-4b')).toEqual({
      providerId: openrouter.id,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or',
      model: 'qwen/qwen3-embedding-4b',
      preset: 'openrouter',
      extraHeaders: { 'x-extra': '1' },
      nativeDimensions: 2560,
      maxInputTokens: 32_768,
      priceInputPerMtokUsd: 0.02,
    })

    const local = await providers.create({
      type: 'openai_compatible',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
    })
    providers.createModel(local.id, { kind: 'embedding', modelId: 'nomic-embed-text' })
    expect(await clients.embeddingApiOptions(local.id, 'nomic-embed-text')).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: null,
      nativeDimensions: null,
      priceInputPerMtokUsd: null,
    })
  })

  it('refuses models that are not registered or were turned off (text search keeps working)', async () => {
    const { store: providers, clients } = testProviders()
    const local = await providers.create({
      type: 'openai_compatible',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
    })
    providers.createModel(local.id, { modelId: 'nomic-embed-text' })
    await expect(clients.embeddingApiOptions(local.id, 'nomic-embed-text')).rejects.toMatchObject({
      code: 'model_not_registered',
    })
    providers.createModel(local.id, { kind: 'embedding', modelId: 'bge-m3', enabled: false })
    await expect(clients.embeddingApiOptions(local.id, 'bge-m3')).rejects.toMatchObject({
      code: 'model_not_registered',
    })
  })

  it('refuses providers without an embeddings API', async () => {
    const { store: providers, clients } = testProviders()
    const anthropic = await providers.create({ type: 'anthropic', name: 'Anthropic', apiKey: 'k' })
    await expect(clients.embeddingApiOptions(anthropic.id, 'x')).rejects.toMatchObject({
      code: 'validation_failed',
    })
  })
})
