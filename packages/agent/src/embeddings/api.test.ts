import { describe, expect, it } from 'vitest'

import { type ApiEmbeddingOptions, ApiEmbeddingProvider, createApiEmbeddingProvider } from './api'
import { EmbeddingError } from './types'

interface Call {
  url: string
  headers: Record<string, string>
  body: { model: string; input: string[]; dimensions?: number; encoding_format?: string }
}

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error

/** Answers each request with the next reply; by default a valid embedding response of `dims`. */
function fakeFetch(dims: number, replies: Reply[] = [], usage?: (input: string[]) => unknown) {
  const calls: Call[] = []
  const doFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Call['body']
    calls.push({ url, headers: init.headers as Record<string, string>, body })
    const reply = replies.shift()
    if (reply instanceof Error) throw reply
    if (reply) {
      return new Response(JSON.stringify(reply.json ?? {}), {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
      })
    }
    // Answer out of order: the provider must sort by `index`.
    const data = body.input
      .map((text, index) => ({
        index,
        embedding: Array.from({ length: dims }, (_, d) => (d === index % dims ? 3 : 0) + text.length / 1000),
      }))
      .reverse()
    return new Response(JSON.stringify({ data, usage: usage?.(body.input) }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, doFetch }
}

const base = (overrides: Partial<ApiEmbeddingOptions> = {}): ApiEmbeddingOptions => ({
  providerId: 'provider_1',
  baseUrl: 'https://openrouter.ai/api/v1/',
  apiKey: 'sk-test',
  model: 'text-embedding-3-small',
  nativeDimensions: 4,
  sleep: async () => {},
  ...overrides,
})

describe('ApiEmbeddingProvider', () => {
  it('posts batches to /embeddings and returns unit vectors in input order', async () => {
    const { calls, doFetch } = fakeFetch(4)
    const provider = new ApiEmbeddingProvider(base({ fetch: doFetch, batchSize: 2 }))
    const res = await provider.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee'], 'document')
    expect(calls.map((c) => c.body.input)).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']])
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/embeddings')
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test')
    expect(calls[0]!.body).toMatchObject({ model: 'text-embedding-3-small', encoding_format: 'float' })
    expect(calls[0]!.body.dimensions).toBeUndefined()
    expect(res.vectors).toHaveLength(5)
    for (const v of res.vectors) expect(Math.hypot(...v)).toBeCloseTo(1, 5)
    // The hot dimension of each vector follows its position inside the batch.
    expect(res.vectors[1]!.indexOf(Math.max(...res.vectors[1]!))).toBe(1)
    expect(res.vectors[2]!.indexOf(Math.max(...res.vectors[2]!))).toBe(0)
    expect(provider.key).toBe('api:provider_1:text-embedding-3-small:4')
    expect(provider.dimensions).toBe(4)
  })

  it('uses the catalog for known models: query instruction and OpenRouter headers', async () => {
    const { calls, doFetch } = fakeFetch(2560)
    const provider = new ApiEmbeddingProvider(
      base({
        model: 'qwen/qwen3-embedding-4b',
        nativeDimensions: 2560,
        preset: 'openrouter',
        fetch: doFetch,
      }),
    )
    expect(provider.dimensions).toBe(2560)
    expect(provider.maxInputTokens).toBe(32_768)
    await provider.embed(['payment terms'], 'query')
    await provider.embed(['Payment is due on the 10th.'], 'document')
    expect(calls[0]!.body.input[0]).toMatch(/^Instruct: .*\nQuery: payment terms$/s)
    expect(calls[1]!.body.input[0]).toBe('Payment is due on the 10th.')
    expect(calls[0]!.headers['x-title']).toBe('Milibot')
  })

  it('sends dimensions when requested and names the space after them', async () => {
    const { calls, doFetch } = fakeFetch(3)
    const provider = new ApiEmbeddingProvider(base({ dimensions: 3, fetch: doFetch }))
    await provider.embed(['x'], 'query')
    expect(calls[0]!.body.dimensions).toBe(3)
    expect(provider.key).toBe('api:provider_1:text-embedding-3-small:3')
  })

  it('reports the provider cost when every response has it, else computes it from the price', async () => {
    const reported = fakeFetch(4, [], (input) => ({ prompt_tokens: input.length * 10, cost: 0.001 }))
    const withCost = new ApiEmbeddingProvider(base({ fetch: reported.doFetch, batchSize: 1 }))
    expect((await withCost.embed(['a', 'b'], 'document')).usage).toEqual({
      tokens: 20,
      costUsd: expect.closeTo(0.002, 9),
    })

    const priced = fakeFetch(4, [], (input) => ({ prompt_tokens: input.length * 500_000 }))
    const withPrice = new ApiEmbeddingProvider(base({ fetch: priced.doFetch, priceInputPerMtokUsd: 0.02 }))
    expect((await withPrice.embed(['a', 'b'], 'document')).usage).toEqual({
      tokens: 1_000_000,
      costUsd: expect.closeTo(0.02, 9),
    })

    const unknown = fakeFetch(4)
    const noPrice = new ApiEmbeddingProvider(base({ fetch: unknown.doFetch }))
    const usage = (await noPrice.embed(['abcdefg'], 'document')).usage
    expect(usage).toEqual({ tokens: 2 })
  })

  it('retries 429 and 5xx (honoring Retry-After) and network errors', async () => {
    const waits: number[] = []
    const { calls, doFetch } = fakeFetch(4, [
      { status: 429, json: { error: { message: 'slow down' } }, headers: { 'retry-after': '2' } },
      { status: 503 },
      new TypeError('fetch failed'),
    ])
    const provider = new ApiEmbeddingProvider(
      base({
        fetch: doFetch,
        sleep: async (ms) => {
          waits.push(ms)
        },
      }),
    )
    const res = await provider.embed(['a'], 'document')
    expect(res.vectors).toHaveLength(1)
    expect(calls).toHaveLength(4)
    expect(waits[0]).toBe(2000)
    expect(waits).toHaveLength(3)
  })

  it('gives up after maxRetries and does not retry client errors', async () => {
    const busy = fakeFetch(4, [{ status: 500 }, { status: 500 }, { status: 500 }])
    const provider = new ApiEmbeddingProvider(base({ fetch: busy.doFetch, maxRetries: 2 }))
    await expect(provider.embed(['a'], 'document')).rejects.toMatchObject({
      name: 'EmbeddingError',
      code: 'provider_error',
      status: 500,
    })
    expect(busy.calls).toHaveLength(3)

    const bad = fakeFetch(4, [{ status: 400, json: { error: { message: 'model not found' } } }])
    const rejecting = new ApiEmbeddingProvider(base({ fetch: bad.doFetch }))
    const err = (await rejecting.embed(['a'], 'document').catch((e: unknown) => e)) as EmbeddingError
    expect(err.status).toBe(400)
    expect(err.message).toContain('model not found')
    expect(bad.calls).toHaveLength(1)
  })

  it('rejects responses with the wrong count or size', async () => {
    const short = fakeFetch(4, [{ json: { data: [{ index: 0, embedding: [1, 0] }] } }])
    const provider = new ApiEmbeddingProvider(base({ fetch: short.doFetch }))
    await expect(provider.embed(['a'], 'document')).rejects.toMatchObject({ code: 'invalid_response' })

    const missing = fakeFetch(4, [{ json: { data: [] } }])
    const other = new ApiEmbeddingProvider(base({ fetch: missing.doFetch }))
    await expect(other.embed(['a'], 'document')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('decodes base64 embeddings', async () => {
    const floats = Buffer.from(new Float32Array([0, 3, 4, 0]).buffer).toString('base64')
    const { doFetch } = fakeFetch(4, [{ json: { data: [{ index: 0, embedding: floats }] } }])
    const res = await new ApiEmbeddingProvider(base({ fetch: doFetch })).embed(['a'], 'document')
    expect(Array.from(res.vectors[0]!)).toEqual([0, expect.closeTo(0.6, 6), expect.closeTo(0.8, 6), 0])
  })

  it('stops on abort, including while waiting to retry', async () => {
    const controller = new AbortController()
    const { doFetch } = fakeFetch(4, [{ status: 429 }])
    const provider = new ApiEmbeddingProvider(
      base({ fetch: doFetch, sleep: undefined as unknown as ApiEmbeddingOptions['sleep'] }),
    )
    const pending = provider.embed(['a'], 'document', controller.signal)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })

  it('needs a known output size', () => {
    expect(() => new ApiEmbeddingProvider(base({ nativeDimensions: null }))).toThrow(EmbeddingError)
  })
})

describe('createApiEmbeddingProvider', () => {
  it('detects the output size of an unknown model with one request', async () => {
    const { calls, doFetch } = fakeFetch(6)
    const provider = await createApiEmbeddingProvider(
      base({ model: 'nomic-embed-text', nativeDimensions: null, fetch: doFetch }),
    )
    expect(provider.dimensions).toBe(6)
    expect(provider.key).toBe('api:provider_1:nomic-embed-text:6')
    expect(calls).toHaveLength(1)
  })

  it('probes the size even for catalog models (it comes from the provider, not from Milibot)', async () => {
    const { calls, doFetch } = fakeFetch(5)
    const provider = await createApiEmbeddingProvider(
      base({ model: 'qwen/qwen3-embedding-8b', nativeDimensions: null, fetch: doFetch }),
    )
    expect(provider.dimensions).toBe(5)
    expect(calls).toHaveLength(1)
  })

  it('skips the probe when the size is known', async () => {
    const { calls, doFetch } = fakeFetch(4)
    await createApiEmbeddingProvider(base({ fetch: doFetch }))
    expect(calls).toHaveLength(0)
  })
})
