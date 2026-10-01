import { describe, expect, it } from 'vitest'

import { pngSize, solidPng } from '../media/png'
import { designTools } from '../tools/families/design'
import { AnthropicProvider, toAnthropicParams } from './anthropic'
import { blobRef, inlineBlobs, MemoryBlobStore } from './blobs'
import { toBase64 } from './http/base64'
import type { ChatMessage } from './messages'
import { outputCap } from './models'
import {
  normalizeOpenAIUsage,
  OpenAICompatibleProvider,
  reasoningField,
  toOpenAIMessages,
} from './openai-compatible'
import { anthropicModelInfo, anthropicPrices } from './pricing'
import { complete } from './provider'
import { usageWithCost } from './usage'

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const blobs = new MemoryBlobStore()
const sha = blobs.add(solidPng(2, 2, [1, 2, 3]))
const image = { type: 'image' as const, sha256: sha, mediaType: 'image/png' as const, width: 2, height: 2 }

const conversation: ChatMessage[] = [
  { role: 'system', content: [{ type: 'text', text: 'be nice' }] },
  { role: 'user', content: [{ type: 'text', text: 'look' }] },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    toolCalls: [{ id: 'c1', name: 'computer', arguments: { action: 'screenshot' } }],
  },
  {
    role: 'tool',
    toolCallId: 'c1',
    toolName: 'computer',
    content: [{ type: 'text', text: 'screen' }, image],
  },
]

describe('blobs', () => {
  it('builds valid PNGs and inlines blob references', async () => {
    const png = solidPng(7, 3, [0, 0, 0])
    expect(pngSize(png)).toEqual({ width: 7, height: 3 })
    const inlined = await inlineBlobs({ a: [`data:image/png;base64,${blobRef(sha)}`] }, blobs)
    expect(inlined.a[0]).toBe(`data:image/png;base64,${toBase64(await blobs.read(sha))}`)
  })
})

describe('cost', () => {
  const tokens = {
    inputTokens: 1_000_000,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }

  it('prefers the provider-reported cost', () => {
    expect(usageWithCost(tokens, 0.42, { ...anthropicPrices('claude-sonnet-5')! })).toMatchObject({
      costUsd: 0.42,
      costSource: 'provider',
    })
  })

  it('computes cost from the price table, and marks unknown without prices', () => {
    expect(usageWithCost(tokens, undefined, anthropicPrices('claude-sonnet-5'))).toMatchObject({
      costUsd: 2,
      costSource: 'computed',
    })
    expect(usageWithCost(tokens, null, null)).toMatchObject({ costUsd: null, costSource: 'unknown' })
  })

  it('matches Anthropic models by longest prefix, including dated snapshots', () => {
    expect(anthropicModelInfo('claude-opus-5-5')?.input).toBe(4)
    expect(anthropicModelInfo('claude-opus-5')?.input).toBe(5)
    expect(anthropicModelInfo('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5')
    expect(anthropicModelInfo('anthropic/claude-sonnet-5')?.id).toBe('claude-sonnet-5')
    expect(anthropicModelInfo('gpt-5')).toBeNull()
    expect(anthropicPrices('claude-haiku-4-5')).toMatchObject({
      priceCacheWritePerMtokUsd: 1.25,
      priceCacheReadPerMtokUsd: 0.1,
    })
  })

  it('normalizes inclusive OpenAI usage into disjoint buckets', () => {
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 1000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
        completion_tokens_details: { reasoning_tokens: 200 },
      }),
    ).toEqual({
      inputTokens: 300,
      cachedReadTokens: 600,
      cacheWriteTokens: 100,
      outputTokens: 100,
      reasoningTokens: 200,
    })
  })
})

describe('openai-compatible', () => {
  it('sends screenshots after tool messages and cache_control for Anthropic models on OpenRouter', () => {
    const messages = toOpenAIMessages(conversation, true)
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    const last = messages.at(-1)
    expect(Array.isArray(last?.content) && last.content.some((p) => p.type === 'image_url')).toBe(true)
    expect(JSON.stringify(messages[0])).toContain('cache_control')
    expect(JSON.stringify(messages)).toContain(blobRef(sha))
  })

  it('streams text and tool calls, reports OpenRouter cost and logs blob references', async () => {
    let sentBody = ''
    const fetchMock: typeof fetch = async (_url, init) => {
      sentBody = String(init?.body)
      return sse([
        { id: 'gen-1', model: 'x', choices: [{ delta: { content: 'Hello' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"comm' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.0012 } },
        '[DONE]',
      ])
    }
    const provider = new OpenAICompatibleProvider({
      id: 'p',
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: 'k',
      preset: 'openrouter',
      fetch: fetchMock,
    })
    const deltas: string[] = []
    const inputs: unknown[] = []
    let result
    for await (const chunk of provider.stream({
      model: 'anthropic/claude-sonnet-5',
      messages: conversation,
      tools: [],
      blobs,
    })) {
      if (chunk.type === 'text_delta') deltas.push(chunk.text)
      if (chunk.type === 'tool_input_delta') inputs.push(chunk)
      if (chunk.type === 'done') result = chunk.result
    }
    expect(deltas).toEqual(['Hello'])
    expect(inputs).toEqual([
      { type: 'tool_input_delta', id: 'call_1', name: 'bash', partialJson: '{"comm' },
      { type: 'tool_input_delta', id: 'call_1', name: 'bash', partialJson: '{"command":"ls"}' },
    ])
    expect(result).toMatchObject({
      stopReason: 'tool_use',
      generationId: 'gen-1',
      usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.0012, costSource: 'provider' },
      message: { toolCalls: [{ id: 'call_1', name: 'bash', arguments: { command: 'ls' } }] },
    })
    expect(JSON.parse(sentBody).usage).toEqual({ include: true })
    expect(sentBody).not.toContain('milibot-blob:')
    expect(JSON.stringify((result as unknown as { rawRequest: unknown }).rawRequest)).toContain(blobRef(sha))
  })

  it('computes cost from provider_models prices for generic endpoints', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'p',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: null,
      preset: null,
      prices: () => ({
        priceInputPerMtokUsd: 1,
        priceOutputPerMtokUsd: 2,
        priceCacheReadPerMtokUsd: null,
        priceCacheWritePerMtokUsd: null,
        pricePerRequestUsd: null,
      }),
      fetch: async () =>
        sse([
          {
            choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
          },
        ]),
    })
    const result = await complete(provider, {
      model: 'local',
      messages: conversation.slice(0, 2),
      tools: [],
      blobs,
    })
    expect(result.usage).toMatchObject({ costUsd: 2, costSource: 'computed' })
    expect(result.stopReason).toBe('end_turn')
  })

  it("keeps a local server's plain reasoning and sends it back only inside the tool loop in progress", async () => {
    const stream = (chunks: unknown[]) =>
      new OpenAICompatibleProvider({
        id: 'p',
        baseUrl: 'http://vllm:8000/v1',
        apiKey: null,
        preset: null,
        fetch: async () => sse(chunks),
      })
    const vllm = await complete(
      stream([
        { choices: [{ delta: { reasoning: 'read ', reasoning_content: 'read ' } }] },
        { choices: [{ delta: { reasoning: 'App.tsx', reasoning_content: 'App.tsx' } }] },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'bash', arguments: '{}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
      { model: 'qwen', messages: conversation, tools: [], blobs },
    )
    expect(vllm.message.providerData).toEqual({
      type: 'openai_compatible',
      content: { field: 'reasoning', text: 'read App.tsx' },
    })
    const older = await complete(stream([{ choices: [{ delta: { reasoning_content: 'hm' } }] }]), {
      model: 'qwen',
      messages: conversation,
      tools: [],
      blobs,
    })
    expect(older.message.providerData?.content).toEqual({ field: 'reasoning_content', text: 'hm' })

    const earlier = { ...vllm.message, providerData: older.message.providerData }
    const loop: ChatMessage[] = [
      conversation[0]!,
      conversation[1]!,
      earlier,
      { role: 'tool', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'go on' }] },
      vllm.message,
      { role: 'tool', toolCallId: 'c2', toolName: 'bash', content: [{ type: 'text', text: 'ok' }] },
    ]
    const assistants = (replay: boolean) =>
      toOpenAIMessages(loop, false, replay).filter((m) => m.role === 'assistant')
    expect(assistants(true)[0]).not.toHaveProperty('reasoning_content')
    expect(assistants(true)[1]).toMatchObject({ reasoning: 'read App.tsx' })
    expect(assistants(false)[1]).not.toHaveProperty('reasoning')
  })

  it('prefers OpenRouter reasoning details over the plain reasoning it also streams', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'p',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      preset: 'openrouter',
      fetch: async () =>
        sse([
          {
            choices: [
              {
                delta: {
                  reasoning: 'hm',
                  reasoning_details: [{ type: 'reasoning.text', text: 'hm', index: 0 }],
                },
              },
            ],
          },
        ]),
    })
    const result = await complete(provider, { model: 'm', messages: conversation, tools: [], blobs })
    expect(result.message.providerData?.content).toEqual([{ type: 'reasoning.text', text: 'hm', index: 0 }])
  })

  it('turns HTTP errors into ProviderError with the request attached', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'p',
      baseUrl: 'http://x/v1',
      apiKey: null,
      preset: null,
      fetch: async () => new Response('{"error":"bad key"}', { status: 401 }),
    })
    await expect(
      complete(provider, { model: 'm', messages: conversation, tools: [], blobs }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      status: 401,
    })
  })
})

describe('anthropic', () => {
  it('maps tool results with images and sets cache breakpoints', () => {
    const params = toAnthropicParams({
      model: 'claude-sonnet-5',
      messages: conversation,
      tools: [{ name: 'computer', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      blobs,
    })
    expect(params.system).toEqual([{ type: 'text', text: 'be nice', cache_control: { type: 'ephemeral' } }])
    expect(params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const last = params.messages[2]?.content as unknown as Array<Record<string, unknown>>
    expect(last[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      cache_control: { type: 'ephemeral' },
    })
    expect(JSON.stringify(last)).toContain(blobRef(sha))
  })

  it('replays provider-native assistant content verbatim', () => {
    const native = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'hi' },
    ]
    const params = toAnthropicParams({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          providerData: { type: 'anthropic', content: native },
        },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
      tools: [],
      blobs,
    })
    expect(params.messages[1]?.content).toEqual(native)
  })

  it('streams the input of tool calls as it is written', async () => {
    const message = {
      id: 'msg_1',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'design_write_frame', input: { design: 'd1' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me draw' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'design_write_frame', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"desi' } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'gn":"d1"}' },
      },
    ]
    const client = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield* events
          },
          finalMessage: async () => message,
        }),
      },
    }
    const anthropic = new AnthropicProvider({ id: 'a', apiKey: 'k', client: client as never })
    const chunks = []
    for await (const chunk of anthropic.stream({
      model: 'claude-sonnet-5',
      messages: conversation.slice(0, 2),
      tools: [],
      blobs,
    })) {
      if (chunk.type !== 'done') chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'text_delta', text: 'Let me draw' },
      { type: 'tool_input_delta', id: 'toolu_1', name: 'design_write_frame', partialJson: '{"desi' },
      { type: 'tool_input_delta', id: 'toolu_1', name: 'design_write_frame', partialJson: '{"design":"d1"}' },
      { type: 'tool_call', call: { id: 'toolu_1', name: 'design_write_frame', arguments: { design: 'd1' } } },
    ])
  })

  it('streams unbuffered input for tools shown while written and reads it strictly', async () => {
    const message = {
      id: 'msg_1',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'design_write_frame',
          input: { design: 'd1', html: '<p>Hel' },
        },
        { type: 'tool_use', id: 'toolu_2', name: 'design_list', input: {} },
      ],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    const events = [
      { type: 'message_start', message },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'design_write_frame', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"design":"d1","html":"<p>Hel' },
      },
    ]
    let sent: { tools?: Array<Record<string, unknown>> } = {}
    const client = {
      messages: {
        stream: (params: typeof sent) => {
          sent = params
          return {
            async *[Symbol.asyncIterator]() {
              yield* events
            },
            finalMessage: async () => message,
          }
        },
      },
    }
    const anthropic = new AnthropicProvider({ id: 'a', apiKey: 'k', client: client as never })
    const calls = []
    for await (const chunk of anthropic.stream({
      model: 'claude-sonnet-5',
      messages: conversation.slice(0, 2),
      tools: [designTools.definitions.design_write_frame, designTools.definitions.design_list],
      blobs,
    })) {
      if (chunk.type === 'tool_call') calls.push(chunk.call)
    }
    expect(sent.tools?.map((t) => [t.name, t.eager_input_streaming])).toEqual([
      ['design_write_frame', true],
      ['design_list', undefined],
    ])
    expect(calls).toEqual([
      {
        id: 'toolu_1',
        name: 'design_write_frame',
        arguments: { __invalidJson: '{"design":"d1","html":"<p>Hel' },
      },
      { id: 'toolu_2', name: 'design_list', arguments: {} },
    ])
  })

  it('caps output by the registered maximum of the model', async () => {
    expect(outputCap(undefined, null)).toBeUndefined()
    expect(outputCap(500, null)).toBe(500)
    expect(outputCap(undefined, 4096)).toBe(4096)
    expect(outputCap(9000, 4096)).toBe(4096)

    const limits = (model: string) =>
      model === 'capped' ? { contextWindow: 8192, maxOutputTokens: 2048 } : null
    const openai = new OpenAICompatibleProvider({
      id: 'o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      preset: null,
      limits,
    })
    const body = openai.buildBody({ model: 'capped', messages: conversation.slice(0, 2), tools: [], blobs })
    expect(body).toMatchObject({ max_completion_tokens: 2048 })
    expect(body).not.toHaveProperty('max_tokens')

    let sent: { max_tokens?: number } | null = null
    const client = {
      messages: {
        stream: (params: { max_tokens?: number }) => {
          sent = params
          throw new Error('stop here')
        },
      },
    }
    const anthropic = new AnthropicProvider({ id: 'a', apiKey: 'k', limits, client: client as never })
    for (const model of ['capped', 'other']) {
      await expect(
        complete(anthropic, { model, messages: conversation.slice(0, 2), tools: [], blobs }),
      ).rejects.toThrow('stop here')
      expect(sent!.max_tokens).toBe(model === 'capped' ? 2048 : 32_000)
    }
  })

  it('leaves image models out of the chat models (they have their own table)', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'p',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: null,
      preset: null,
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-4.1' },
              { id: 'gpt-image-1' },
              { id: 'dall-e-3' },
              { id: 'google/gemini-2.5-flash-image', architecture: { output_modalities: ['image', 'text'] } },
            ],
          }),
        ),
    })
    expect((await provider.listModels()).map((m) => m.modelId)).toEqual(['gpt-4.1'])
  })

  it('lists chat models with their output cap and leaves embedding models out', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'p',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: null,
      preset: 'openrouter',
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'anthropic/claude-haiku-4.5',
                context_length: 200_000,
                architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
                top_provider: { context_length: 200_000, max_completion_tokens: 64_000 },
                pricing: { prompt: '0.000001', completion: '0.000005' },
              },
              {
                id: 'qwen/qwen3-embedding-4b',
                context_length: 32_768,
                architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
              },
            ],
          }),
        ),
    })
    expect(await provider.listModels()).toEqual([
      expect.objectContaining({
        kind: 'chat',
        modelId: 'anthropic/claude-haiku-4.5',
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        priceInputPerMtokUsd: 1,
        dimensions: null,
      }),
    ])
  })

  it('lists OpenRouter efforts from the parameters a model supports', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'p',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: null,
      preset: 'openrouter',
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'thinks', supported_parameters: ['tools', 'reasoning'] },
              { id: 'plain', supported_parameters: ['tools'] },
              { id: 'unknown' },
            ],
          }),
        ),
    })
    const efforts = Object.fromEntries((await provider.listModels()).map((m) => [m.modelId, m.efforts]))
    expect(efforts).toEqual({ thinks: ['low', 'medium', 'high', 'xhigh'], plain: [], unknown: null })
  })
})

describe('reasoning effort', () => {
  const openai = { baseUrl: 'https://api.openai.com/v1', preset: null }
  const openrouter = { baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter' }
  const custom = { baseUrl: 'http://localhost:8080/v1', preset: null }

  it('picks the field of each server', () => {
    expect(reasoningField(openai, 'high', null)).toEqual({ reasoning_effort: 'high' })
    expect(reasoningField(openrouter, 'medium', null)).toEqual({ reasoning: { effort: 'medium' } })
    expect(reasoningField(openrouter, 'max', null)).toEqual({ reasoning: { effort: 'xhigh' } })
    expect(reasoningField(custom, 'high', null)).toEqual({})
    expect(reasoningField(custom, 'high', ['low', 'high'])).toEqual({ reasoning_effort: 'high' })
    expect(reasoningField({ ...custom, reasoningParam: 'reasoning_effort' }, 'low', null)).toEqual({
      reasoning_effort: 'low',
    })
    expect(reasoningField({ ...openrouter, reasoningParam: 'none' }, 'high', null)).toEqual({})
    expect(reasoningField(openai, null, null)).toEqual({})
  })

  it('sends the nearest level the model accepts, or none', () => {
    expect(reasoningField(openai, 'xhigh', ['low', 'medium', 'high'])).toEqual({ reasoning_effort: 'high' })
    expect(reasoningField(openai, 'high', [])).toEqual({})
  })

  it('builds the OpenAI-compatible body with the effort and the chosen cap field', () => {
    const provider = new OpenAICompatibleProvider({
      ...custom,
      id: 'c',
      apiKey: null,
      outputCapField: 'max_completion_tokens',
      limits: () => ({ contextWindow: null, maxOutputTokens: null, efforts: ['low', 'medium', 'high'] }),
    })
    const body = provider.buildBody({
      model: 'm',
      messages: conversation.slice(0, 2),
      tools: [],
      blobs,
      maxOutputTokens: 1000,
      effort: 'max',
    })
    expect(body).toMatchObject({ max_completion_tokens: 1000, reasoning_effort: 'high' })
  })

  it('sends Anthropic effort, with adaptive thinking only where it is opt-in and above low', () => {
    const base = { messages: conversation.slice(0, 2), tools: [], blobs }
    expect(toAnthropicParams({ ...base, model: 'claude-opus-5-5', effort: 'high' })).toMatchObject({
      output_config: { effort: 'high' },
    })
    expect(toAnthropicParams({ ...base, model: 'claude-opus-5-5', effort: 'high' })).not.toHaveProperty(
      'thinking',
    )
    expect(toAnthropicParams({ ...base, model: 'claude-opus-4-8', effort: 'high' })).toMatchObject({
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive' },
    })
    expect(toAnthropicParams({ ...base, model: 'claude-opus-4-8', effort: 'low' })).not.toHaveProperty(
      'thinking',
    )
    expect(toAnthropicParams({ ...base, model: 'claude-sonnet-4-6', effort: 'xhigh' })).toMatchObject({
      output_config: { effort: 'max' },
    })
    expect(toAnthropicParams({ ...base, model: 'claude-haiku-4-5', effort: 'high' })).not.toHaveProperty(
      'output_config',
    )
    expect(toAnthropicParams({ ...base, model: 'claude-opus-5-5' })).not.toHaveProperty('output_config')
  })
})
