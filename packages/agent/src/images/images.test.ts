import { describe, expect, it } from 'vitest'

import { solidPng } from '../media/png'
import { checkImageRequest } from './catalog'
import {
  listImageModels,
  parseGenericImageModels,
  parseGoogleImageModels,
  parseOpenRouterImageModels,
} from './discovery'
import { fakeGenerateImages } from './fake'
import { generateImages } from './generate'
import { openAiImageSize } from './openai-images'
import type { ImageRequest } from './types'

const PNG = solidPng(4, 4, [10, 20, 30])
const B64 = Buffer.from(PNG).toString('base64')

interface Seen {
  url: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(answer: (url: string, body: unknown) => unknown, status = 200) {
  const seen: Seen[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const body =
      init?.body instanceof FormData
        ? init.body
        : typeof init?.body === 'string'
          ? JSON.parse(init.body)
          : null
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body })
    return new Response(JSON.stringify(answer(url, body)), { status })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const request = (patch: Partial<ImageRequest> = {}): ImageRequest => ({
  model: 'google/gemini-2.5-flash-image',
  prompt: 'A red fox in the snow',
  count: 1,
  aspect: '1:1',
  transparent: false,
  references: [],
  ...patch,
})

describe('generateImages', () => {
  it('draws through OpenRouter chat completions, one call per picture, with the reported cost', async () => {
    const { fetch, seen } = fakeFetch(() => ({
      choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${B64}` } }] } }],
      usage: { cost: 0.039 },
    }))
    const result = await generateImages(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or', preset: 'openrouter', fetch },
      request({ count: 2, aspect: '16:9' }),
    )
    expect(result.images).toHaveLength(2)
    expect(Buffer.from(result.images[0]!.bytes).equals(Buffer.from(PNG))).toBe(true)
    expect(result.costUsd).toBeCloseTo(0.078)
    expect(seen).toHaveLength(2)
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(seen[0]!.headers.authorization).toBe('Bearer sk-or')
    expect(seen[0]!.body).toMatchObject({
      model: 'google/gemini-2.5-flash-image',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '16:9' },
    })
  })

  it('sends reference images to OpenRouter as data URLs', async () => {
    const { fetch, seen } = fakeFetch(() => ({
      choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${B64}` } }] } }],
    }))
    const result = await generateImages(
      { baseUrl: 'https://openrouter.ai/api/v1', apiKey: null, preset: 'openrouter', fetch },
      request({ references: [{ bytes: PNG, mediaType: 'image/png' }] }),
    )
    expect(result.costUsd).toBeNull()
    const content = (seen[0]!.body as { messages: Array<{ content: unknown[] }> }).messages[0]!.content
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } })
  })

  it('fails with no_image when the model answers in text only', async () => {
    const { fetch } = fakeFetch(() => ({ choices: [{ message: { content: 'I cannot draw that' } }] }))
    await expect(
      generateImages(
        { baseUrl: 'https://openrouter.ai/api/v1', apiKey: null, preset: 'openrouter', fetch },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'no_image' })
  })

  it('uses the OpenAI Images API with n, size and a transparent background for gpt-image', async () => {
    const { fetch, seen } = fakeFetch(() => ({ data: [{ b64_json: B64 }, { b64_json: B64 }] }))
    const result = await generateImages(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', preset: null, fetch },
      request({ model: 'gpt-image-1', count: 2, aspect: '2:3', transparent: true }),
    )
    expect(result.images).toHaveLength(2)
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/images/generations')
    expect(seen[0]!.body).toMatchObject({
      model: 'gpt-image-1',
      n: 2,
      size: '1024x1536',
      background: 'transparent',
      output_format: 'png',
    })
  })

  it('edits with reference images through a multipart /images/edits', async () => {
    const { fetch, seen } = fakeFetch(() => ({ data: [{ b64_json: B64 }] }))
    await generateImages(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', preset: null, fetch },
      request({ model: 'gpt-image-1', references: [{ bytes: PNG, mediaType: 'image/png' }] }),
    )
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/images/edits')
    const form = seen[0]!.body as FormData
    expect(form.get('prompt')).toBe('A red fox in the snow')
    expect(form.getAll('image[]')).toHaveLength(1)
  })

  it('draws with Gemini through the native generateContent and the Google key header', async () => {
    const { fetch, seen } = fakeFetch(() => ({
      candidates: [
        {
          content: { parts: [{ text: 'Here it is' }, { inlineData: { mimeType: 'image/png', data: B64 } }] },
        },
      ],
    }))
    const result = await generateImages(
      {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: 'AIza',
        preset: 'google',
        fetch,
      },
      request({ model: 'gemini-2.5-flash-image', aspect: '3:2' }),
    )
    expect(result.images).toHaveLength(1)
    expect(seen[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    )
    expect(seen[0]!.headers['x-goog-api-key']).toBe('AIza')
    expect(seen[0]!.body).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: '3:2' } } })
  })

  it('draws several Imagen pictures in one predict call, at the nearest aspect it takes', async () => {
    const { fetch, seen } = fakeFetch(() => ({
      predictions: [
        { bytesBase64Encoded: B64, mimeType: 'image/png' },
        { bytesBase64Encoded: B64, mimeType: 'image/png' },
      ],
    }))
    const result = await generateImages(
      {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: 'AIza',
        preset: null,
        fetch,
      },
      request({ model: 'imagen-4.0-generate-001', count: 2, aspect: '2:3' }),
    )
    expect(result.images).toHaveLength(2)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toContain('/models/imagen-4.0-generate-001:predict')
    expect(seen[0]!.body).toMatchObject({ parameters: { sampleCount: 2, aspectRatio: '3:4' } })
  })

  it("carries the provider's message on an error", async () => {
    const { fetch } = fakeFetch(() => ({ error: { message: 'Invalid API key' } }), 401)
    await expect(
      generateImages(
        { baseUrl: 'https://api.openai.com/v1', apiKey: 'bad', preset: null, fetch },
        request({ model: 'gpt-image-1' }),
      ),
    ).rejects.toMatchObject({ code: 'provider_error', status: 401, message: 'HTTP 401: Invalid API key' })
  })
})

describe('provider errors', () => {
  const google = (fetch: typeof globalThis.fetch, sleep: (ms: number) => Promise<void> = async () => {}) => ({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: 'AIza',
    preset: 'google',
    fetch,
    sleep,
  })

  it('never retries a 429 that means no quota, and keeps only the first line of the message', async () => {
    const { fetch, seen } = fakeFetch(
      () => ({
        error: {
          message:
            'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 0',
        },
      }),
      429,
    )
    await expect(
      generateImages(google(fetch), request({ model: 'gemini-2.5-flash-image' })),
    ).rejects.toMatchObject({
      code: 'quota',
      message: 'HTTP 429: You exceeded your current quota, please check your plan and billing details.',
    })
    expect(seen).toHaveLength(1)
  })

  it('waits out a rate limit itself before answering', async () => {
    let calls = 0
    const waits: number[] = []
    const fetch = (async () => {
      calls++
      return calls < 3
        ? new Response(
            JSON.stringify({ error: { message: 'Resource has been exhausted, try again later' } }),
            {
              status: 429,
              headers: { 'retry-after': '5' },
            },
          )
        : new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: B64 } }] } }],
            }),
          )
    }) as typeof globalThis.fetch
    const result = await generateImages(
      google(fetch, async (ms: number) => {
        waits.push(ms)
      }),
      request({ model: 'gemini-2.5-flash-image' }),
    )
    expect(result.images).toHaveLength(1)
    expect(waits).toEqual([5000, 5000])
  })

  it('gives up as rate_limited after its retries', async () => {
    const { fetch, seen } = fakeFetch(() => ({ error: { message: 'Too many requests' } }), 429)
    await expect(
      generateImages(google(fetch), request({ model: 'gemini-2.5-flash-image' })),
    ).rejects.toMatchObject({
      code: 'rate_limited',
    })
    expect(seen).toHaveLength(4)
  })

  it('treats a 402 as no credit', async () => {
    const { fetch } = fakeFetch(() => ({ error: { message: 'Insufficient credits' } }), 402)
    await expect(
      generateImages(
        { baseUrl: 'https://openrouter.ai/api/v1', apiKey: null, preset: 'openrouter', fetch },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'quota' })
  })
})

describe('checkImageRequest', () => {
  const google = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', preset: 'google' }

  it('refuses a transparent background on models that cannot draw one', () => {
    expect(() =>
      checkImageRequest(google, { model: 'gemini-2.5-flash-image', transparent: true, referenceCount: 0 }),
    ).toThrow(/transparent/)
    expect(() =>
      checkImageRequest(
        { baseUrl: 'https://api.openai.com/v1', preset: null },
        { model: 'gpt-image-1', transparent: true, referenceCount: 0 },
      ),
    ).not.toThrow()
  })

  it('refuses reference images on Imagen and DALL·E 3', () => {
    expect(() =>
      checkImageRequest(google, { model: 'imagen-4.0-generate-001', transparent: false, referenceCount: 1 }),
    ).toThrow(/reference/)
    expect(() =>
      checkImageRequest(
        { baseUrl: 'https://api.openai.com/v1', preset: null },
        { model: 'dall-e-3', transparent: false, referenceCount: 1 },
      ),
    ).toThrow(/reference/)
  })
})

describe('image model listings', () => {
  it('keeps only image-output models from OpenRouter, with reference support from the inputs', () => {
    const models = parseOpenRouterImageModels({
      data: [
        {
          id: 'google/gemini-2.5-flash-image',
          name: 'Gemini 2.5 Flash Image',
          architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] },
        },
        { id: 'openai/gpt-4o', architecture: { output_modalities: ['text'] } },
      ],
    })
    expect(models).toEqual([
      expect.objectContaining({
        modelId: 'google/gemini-2.5-flash-image',
        supportsVision: true,
        pricePerImageUsd: 0.039,
      }),
    ])
  })

  it("lists Google's Gemini image models and Imagen by their generation methods", () => {
    const models = parseGoogleImageModels({
      models: [
        {
          name: 'models/gemini-2.5-flash-image',
          displayName: 'Nano Banana',
          supportedGenerationMethods: ['generateContent'],
        },
        { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    })
    expect(models.map((m) => [m.modelId, m.supportsVision])).toEqual([
      ['gemini-2.5-flash-image', true],
      ['imagen-4.0-generate-001', false],
    ])
  })

  it('guesses image models from the ids of a plain /models, likely ones first', () => {
    const models = parseGenericImageModels({
      data: [{ id: 'gpt-4.1' }, { id: 'gpt-image-1' }, { id: 'dall-e-3' }],
    })
    expect(models.map((m) => [m.modelId, m.image])).toEqual([
      ['dall-e-3', true],
      ['gpt-image-1', true],
      ['gpt-4.1', false],
    ])
  })

  it('asks OpenRouter only for image models', async () => {
    const { fetch, seen } = fakeFetch(() => ({ data: [] }))
    const list = await listImageModels({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: null,
      preset: null,
      fetch,
    })
    expect(list.verified).toBe(true)
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/models?output_modalities=image')
  })
})

describe('helpers', () => {
  it('maps aspects to the sizes each OpenAI model accepts', () => {
    expect(openAiImageSize('gpt-image-1', '16:9')).toBe('1536x1024')
    expect(openAiImageSize('dall-e-3', '9:16')).toBe('1024x1792')
    expect(openAiImageSize('dall-e-2', '16:9')).toBe('1024x1024')
  })

  it('fakes pictures shaped like the aspect, one color per prompt and take', async () => {
    const result = await fakeGenerateImages(
      { baseUrl: 'x', apiKey: null, preset: null },
      request({ count: 2, aspect: '16:9' }),
    )
    expect(result.images).toHaveLength(2)
    expect(Buffer.from(result.images[0]!.bytes).equals(Buffer.from(result.images[1]!.bytes))).toBe(false)
  })
})
