import { describe, expect, it } from 'vitest'

import {
  listEmbeddingModels,
  parseGenericModels,
  parseOpenRouterEmbeddingModels,
  probeEmbeddingModel,
  probeErrorCode,
} from './discovery'
import openRouterListing from './fixtures/openrouter-embedding-models.json'
import { EmbeddingError } from './types'

function fakeFetch(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = []
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return respond(String(url), init)
  }) as typeof fetch
  return { calls, doFetch }
}

describe('parseOpenRouterEmbeddingModels', () => {
  it('reads names, prices per 1M tokens, context and short descriptions from the real listing', () => {
    const models = parseOpenRouterEmbeddingModels(openRouterListing)
    expect(models.map((m) => m.modelId)).toEqual([
      'liquid/lfm-2.5-embedding-350m:free',
      'openai/text-embedding-3-small',
      'qwen/qwen3-embedding-8b',
      'qwen/qwen3-embedding-4b',
    ])
    expect(models[0]).toEqual({
      modelId: 'liquid/lfm-2.5-embedding-350m:free',
      displayName: 'LiquidAI: LFM2.5-Embedding-350M (free)',
      description: 'LFM2.5-Embedding-350M is a text embedding model from Liquid AI.',
      contextWindow: 512,
      priceInputPerMtokUsd: 0,
      dimensions: null,
      embedding: true,
      suggested: false,
    })
    expect(models.find((m) => m.modelId === 'qwen/qwen3-embedding-4b')).toMatchObject({
      displayName: 'Qwen: Qwen3 Embedding 4B',
      contextWindow: 32_768,
      priceInputPerMtokUsd: 0.02,
      suggested: true,
    })
    expect(models.find((m) => m.modelId === 'openai/text-embedding-3-small')?.priceInputPerMtokUsd).toBe(0.02)
  })

  it('never guesses: long descriptions and missing fields stay empty', () => {
    const [model] = parseOpenRouterEmbeddingModels({
      data: [{ id: 'x/embed', description: `${'word '.repeat(60)}end.` }, { name: 'no id' }],
    })
    expect(model).toMatchObject({
      displayName: 'x/embed',
      description: null,
      contextWindow: null,
      priceInputPerMtokUsd: null,
      dimensions: null,
    })
  })

  it('drops models that do not output embeddings', () => {
    const models = parseOpenRouterEmbeddingModels({
      data: [
        { id: 'a/chat', architecture: { output_modalities: ['text'] } },
        { id: 'a/embed', architecture: { output_modalities: ['embeddings'] } },
      ],
    })
    expect(models.map((m) => m.modelId)).toEqual(['a/embed'])
  })
})

describe('parseGenericModels', () => {
  it('lists every model, embedding-looking ids first', () => {
    const models = parseGenericModels({
      data: [
        { id: 'llama3.1:8b' },
        { id: 'nomic-embed-text:latest' },
        { id: 'bge-m3' },
        { id: 'text-embedding-3-large' },
        { id: 'gpt-4o' },
      ],
    })
    expect(models.map((m) => [m.modelId, m.embedding])).toEqual([
      ['bge-m3', true],
      ['nomic-embed-text:latest', true],
      ['text-embedding-3-large', true],
      ['gpt-4o', false],
      ['llama3.1:8b', false],
    ])
    expect(models.every((m) => m.priceInputPerMtokUsd === null && m.dimensions === null)).toBe(true)
  })
})

describe('listEmbeddingModels', () => {
  it('asks OpenRouter for embedding models, with the key when there is one', async () => {
    const { calls, doFetch } = fakeFetch(() => new Response(JSON.stringify(openRouterListing)))
    const withKey = await listEmbeddingModels({
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: 'sk-or',
      preset: 'openrouter',
      fetch: doFetch,
    })
    expect(withKey.verified).toBe(true)
    expect(withKey.models).toHaveLength(4)
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/models?output_modalities=embeddings')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-or')

    await listEmbeddingModels({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: null,
      preset: null,
      fetch: doFetch,
    })
    expect(calls[1]!.headers.get('authorization')).toBeNull()
  })

  it('lists /models of other servers as unverified', async () => {
    const { calls, doFetch } = fakeFetch(
      () => new Response(JSON.stringify({ data: [{ id: 'nomic-embed-text' }, { id: 'llama3' }] })),
    )
    const listed = await listEmbeddingModels({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: null,
      preset: null,
      extraHeaders: { 'x-team': 'a' },
      fetch: doFetch,
    })
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/models')
    expect(calls[0]!.headers.get('x-team')).toBe('a')
    expect(listed).toMatchObject({ verified: false, models: [{ embedding: true }, { embedding: false }] })
  })

  it('fails with the HTTP status', async () => {
    const { doFetch } = fakeFetch(() => new Response('nope', { status: 503 }))
    await expect(
      listEmbeddingModels({ baseUrl: 'http://x/v1', apiKey: null, preset: null, fetch: doFetch }),
    ).rejects.toMatchObject({ code: 'provider_error', status: 503 })
  })
})

describe('probeEmbeddingModel', () => {
  const server = { baseUrl: 'http://localhost:1234/v1', apiKey: 'k', preset: null }

  it('returns the vector size of a model that embeds', async () => {
    const { calls, doFetch } = fakeFetch(
      () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] })),
    )
    expect(await probeEmbeddingModel({ ...server, model: 'nomic-embed-text', fetch: doFetch })).toEqual({
      ok: true,
      dimensions: 4,
      errorCode: null,
      error: null,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://localhost:1234/v1/embeddings')
    expect(calls[0]!.body).toMatchObject({ model: 'nomic-embed-text', input: ['dimension probe'] })
  })

  it('explains why a model does not work, without retrying', async () => {
    const cases: Array<[Response, string]> = [
      [new Response('{"error":"invalid key"}', { status: 401 }), 'unauthorized'],
      [new Response('{"error":"model \\"x\\" not found"}', { status: 400 }), 'model_not_found'],
      [new Response('{"error":"nope"}', { status: 404 }), 'model_not_found'],
      [new Response('{"error":"this model does not support embeddings"}', { status: 400 }), 'not_embedding'],
      [new Response('{"data":[]}'), 'invalid_response'],
      [
        new Response('{"error":{"message":"embedding endpoint unavailable for this model"}}'),
        'not_embedding',
      ],
      [new Response('overloaded', { status: 503 }), 'provider_error'],
    ]
    for (const [response, code] of cases) {
      const { calls, doFetch } = fakeFetch(() => response)
      const result = await probeEmbeddingModel({ ...server, model: 'x', fetch: doFetch })
      expect(result, code).toMatchObject({ ok: false, dimensions: null, errorCode: code })
      expect(calls).toHaveLength(1)
    }
  })

  it('reports an unreachable server', async () => {
    const doFetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    expect(await probeEmbeddingModel({ ...server, model: 'x', fetch: doFetch })).toMatchObject({
      ok: false,
      errorCode: 'unreachable',
    })
    expect(probeErrorCode(new EmbeddingError('aborted', 'timeout'))).toBe('unreachable')
  })
})
