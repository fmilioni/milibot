import {
  type OutputCapField,
  pickEffort,
  type ProviderType,
  type ReasoningEffort,
  type ReasoningParam,
  type ReasoningReplay,
} from '@milibot/shared'

import { parseToolArguments } from '../tools/args'
import { blobRef, inlineBlobs } from './blobs'
import { testWithToolAndImage } from './connection-test'
import { apiHeaders } from './http/headers'
import { perMillion, positiveInt } from './http/listing'
import { readSseData } from './http/sse'
import {
  type AssistantMessage,
  type ChatMessage,
  type ContentPart,
  systemCacheParts,
  textOfParts,
  type ToolCall,
} from './messages'
import { discoveredChatModel, type DiscoveredModel, type ModelLimits, outputCap } from './models'
import {
  type CompletionRequest,
  type ConnectionTestResult,
  type LLMProvider,
  ProviderError,
  type StopReason,
  type StreamChunk,
} from './provider'
import { toOpenAiTool } from './tool-schema'
import { type PriceTable, usageWithCost } from './usage'

export interface OpenAICompatibleOptions {
  id: string
  baseUrl: string
  apiKey: string | null
  preset: string | null
  extraHeaders?: Record<string, string>
  /** Prices of a model from `provider_models` (null when unknown). */
  prices?: (model: string) => PriceTable | null
  /** Registered context, output cap and efforts of a model (`provider_models`). */
  limits?: (model: string) => ModelLimits | null
  reasoningParam?: ReasoningParam
  outputCapField?: OutputCapField
  reasoningReplay?: ReasoningReplay
  fetch?: typeof fetch
}

/** OpenRouter's reasoning blocks of a turn, sent back so the model keeps its thinking across tool calls. */
type ReasoningDetail = Record<string, unknown> & { index?: number }

/** Plain reasoning of a turn (vLLM, SGLang, llama.cpp), sent back in the field it came in. */
type ReasoningText = { field: 'reasoning' | 'reasoning_content'; text: string }

type OaiPart =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string } }

interface OaiReasoning {
  reasoning_details?: ReasoningDetail[]
  reasoning?: string
  reasoning_content?: string
}

type OaiMessage =
  | { role: 'system'; content: string | OaiPart[] }
  | { role: 'user'; content: string | OaiPart[] }
  | ({
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    } & OaiReasoning)
  | { role: 'tool'; tool_call_id: string; content: string }

interface OaiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  cost?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null
  completion_tokens_details?: { reasoning_tokens?: number } | null
}

interface OaiChunk {
  id?: string
  model?: string
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
      reasoning_details?: ReasoningDetail[]
      reasoning?: string | null
      reasoning_content?: string | null
    }
    finish_reason?: string | null
  }>
  usage?: OaiUsage | null
  error?: { message?: string; code?: number | string }
}

function toParts(parts: ContentPart[]): OaiPart[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${blobRef(p.sha256)}` } },
  )
}

/** Anthropic models behind OpenRouter honor `cache_control` on text parts. */
function wantsCacheControl(preset: string | null, model: string): boolean {
  return preset === 'openrouter' && model.startsWith('anthropic/')
}

function isReasoningText(value: unknown): value is ReasoningText {
  if (!value || typeof value !== 'object') return false
  const { field, text } = value as Partial<ReasoningText>
  return (field === 'reasoning' || field === 'reasoning_content') && typeof text === 'string'
}

function reasoningOf(message: AssistantMessage, replayText: boolean): OaiReasoning {
  if (message.providerData?.type !== 'openai_compatible') return {}
  const content = message.providerData.content
  if (Array.isArray(content)) return { reasoning_details: content as ReasoningDetail[] }
  if (replayText && isReasoningText(content)) return { [content.field]: content.text }
  return {}
}

export function toOpenAIMessages(
  messages: ChatMessage[],
  cacheControl: boolean,
  replayReasoningText = true,
): OaiMessage[] {
  const out: OaiMessage[] = []
  // Plain reasoning only matters inside the tool loop in progress (what chat templates such as Qwen's keep).
  const loopStart = messages.findLastIndex((m) => m.role === 'user')
  // Tool messages cannot carry images, so screenshots are sent right after as a user message.
  let pendingImages: OaiPart[] = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    out.push({
      role: 'user',
      content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...pendingImages],
    })
    pendingImages = []
  }
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool') flushImages()
    switch (message.role) {
      case 'system': {
        const parts = message.content.filter(
          (p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text' && p.text.length > 0,
        )
        if (!cacheControl) {
          out.push({ role: 'system', content: parts.map((p) => p.text).join('\n\n') })
          break
        }
        out.push({
          role: 'system',
          content: systemCacheParts([message]).map((p) => ({
            type: 'text' as const,
            text: p.text,
            ...(p.breakpoint ? { cache_control: { type: 'ephemeral' as const } } : {}),
          })),
        })
        break
      }
      case 'user':
        out.push({ role: 'user', content: toParts(message.content) })
        break
      case 'assistant':
        out.push({
          role: 'assistant',
          content: textOfParts(message.content, '\n') || null,
          ...reasoningOf(message, replayReasoningText && index > loopStart),
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                })),
              }
            : {}),
        })
        break
      case 'tool': {
        const images = message.content.filter((p) => p.type === 'image')
        const text =
          textOfParts(message.content, '\n') || (images.length ? '(image attached below)' : '(no output)')
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.isError ? `ERROR: ${text}` : text,
        })
        pendingImages.push(...toParts(images))
        break
      }
    }
  }
  flushImages()
  if (cacheControl) {
    const last = [...out].reverse().find((m) => m.role === 'user')
    if (last && Array.isArray(last.content)) {
      const lastText = [...last.content].reverse().find((p) => p.type === 'text')
      if (lastText && lastText.type === 'text') lastText.cache_control = { type: 'ephemeral' }
    }
  }
  return out
}

/** Normalizes inclusive OpenAI-style counts into the disjoint buckets stored in `llm_calls`. */
export function normalizeOpenAIUsage(usage: OaiUsage | null | undefined) {
  const prompt = usage?.prompt_tokens ?? 0
  const completion = usage?.completion_tokens ?? 0
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWrite = usage?.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0
  return {
    inputTokens: Math.max(0, prompt - cached - cacheWrite),
    cachedReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: Math.max(0, completion - reasoning),
    reasoningTokens: reasoning,
  }
}

function mapFinish(reason: string | null, hasTools: boolean): StopReason {
  if (hasTools || reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  if (reason === 'error') return 'error'
  return 'end_turn'
}

/** Image models that servers without modalities (OpenAI, Google) list next to the chat ones. */
const IMAGE_ONLY_ID = /(^|\/)(gpt-image|dall-e|imagen-)|-image(-preview)?$/

interface OpenRouterModel {
  id: string
  name?: string
  context_length?: number
  pricing?: Record<string, string | undefined>
  architecture?: { input_modalities?: string[]; output_modalities?: string[] }
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null
  supported_parameters?: string[]
}

function isOpenAi(baseUrl: string): boolean {
  return /\/\/api\.openai\.com\b/.test(baseUrl)
}

/** OpenAI's own API wants `max_completion_tokens` (reasoning models refuse `max_tokens`). */
function outputCapField(
  baseUrl: string,
  chosen: OutputCapField | undefined,
): 'max_tokens' | 'max_completion_tokens' {
  if (chosen && chosen !== 'auto') return chosen
  return isOpenAi(baseUrl) ? 'max_completion_tokens' : 'max_tokens'
}

/** OpenRouter's unified `reasoning.effort` stops at `xhigh`. */
const OPENROUTER_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

/**
 * The reasoning field of a request: `auto` sends `reasoning` to OpenRouter, `reasoning_effort` to OpenAI
 * and to any server whose model has efforts registered, nothing otherwise.
 */
export function reasoningField(
  options: { baseUrl: string; preset: string | null; reasoningParam?: ReasoningParam },
  requested: ReasoningEffort | null | undefined,
  efforts: readonly ReasoningEffort[] | null | undefined,
): Record<string, unknown> {
  const param = options.reasoningParam ?? 'auto'
  const style =
    param !== 'auto'
      ? param
      : options.preset === 'openrouter'
        ? 'openrouter'
        : isOpenAi(options.baseUrl) || efforts?.length
          ? 'reasoning_effort'
          : 'none'
  if (style === 'none') return {}
  const effort = pickEffort(requested, style === 'openrouter' ? (efforts ?? OPENROUTER_EFFORTS) : efforts)
  if (!effort) return {}
  if (style === 'openrouter') return { reasoning: { effort: effort === 'max' ? 'xhigh' : effort } }
  return { reasoning_effort: effort }
}

/** Streamed reasoning details arrive in pieces; pieces with the same index form one block. */
function mergeReasoningDetails(into: ReasoningDetail[], pieces: ReasoningDetail[]): void {
  for (const piece of pieces) {
    const target = piece.index === undefined ? undefined : into.find((d) => d.index === piece.index)
    if (!target) {
      into.push({ ...piece })
      continue
    }
    for (const [key, value] of Object.entries(piece)) {
      const current = target[key]
      target[key] =
        typeof value === 'string' && typeof current === 'string' && ['text', 'summary', 'data'].includes(key)
          ? current + value
          : value
    }
  }
}

/** Efforts of an OpenRouter model: listed parameters say whether it reasons at all. */
function listedEfforts(params: string[] | undefined): ReasoningEffort[] | null {
  if (!params) return null
  return params.includes('reasoning') || params.includes('reasoning_effort') ? [...OPENROUTER_EFFORTS] : []
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly type: ProviderType = 'openai_compatible'
  readonly id: string
  private readonly doFetch: typeof fetch

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id
    this.doFetch = options.fetch ?? fetch
  }

  private get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    return apiHeaders({
      apiKey: this.options.apiKey,
      extraHeaders: this.options.extraHeaders,
      json: true,
      openRouter: this.options.preset === 'openrouter',
    })
  }

  buildBody(request: CompletionRequest): Record<string, unknown> {
    const openrouter = this.options.preset === 'openrouter'
    const limits = this.options.limits?.(request.model)
    const maxTokens = outputCap(request.maxOutputTokens ?? undefined, limits?.maxOutputTokens)
    return {
      model: request.model,
      messages: toOpenAIMessages(
        request.messages,
        wantsCacheControl(this.options.preset, request.model),
        this.options.reasoningReplay !== 'off',
      ),
      ...(request.tools.length
        ? {
            tools: request.tools.map(toOpenAiTool),
            ...(request.toolChoice === 'none' ? { tool_choice: 'none' } : {}),
          }
        : {}),
      ...(maxTokens ? { [outputCapField(this.baseUrl, this.options.outputCapField)]: maxTokens } : {}),
      ...reasoningField(
        { baseUrl: this.baseUrl, preset: this.options.preset, reasoningParam: this.options.reasoningParam },
        request.effort,
        limits?.efforts,
      ),
      stream: true,
      stream_options: { include_usage: true },
      ...(openrouter ? { usage: { include: true } } : {}),
    }
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    const rawRequest = this.buildBody(request)
    const body = await inlineBlobs(rawRequest, request.blobs)
    const started = Date.now()
    let res: Response
    try {
      res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal,
      })
    } catch (err) {
      if (request.signal?.aborted) throw err
      throw new ProviderError(`request failed: ${(err as Error).message}`, null, rawRequest)
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 2000)}`, res.status, rawRequest, text)
    }

    let text = ''
    let generationId: string | null = null
    let model: string | null = null
    let finish: string | null = null
    let usage: OaiUsage | null = null
    const calls = new Map<number, { id: string; name: string; args: string }>()
    const reasoningDetails: ReasoningDetail[] = []
    let reasoningText: ReasoningText | null = null
    const chunks: unknown[] = []

    for await (const data of readSseData(res.body)) {
      if (data === '[DONE]') break
      let chunk: OaiChunk
      try {
        chunk = JSON.parse(data) as OaiChunk
      } catch {
        continue
      }
      if (chunk.error) {
        throw new ProviderError(
          `provider error: ${chunk.error.message ?? 'unknown'}`,
          null,
          rawRequest,
          chunk,
        )
      }
      generationId ??= chunk.id ?? null
      model ??= chunk.model ?? null
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      if (choice?.finish_reason) finish = choice.finish_reason
      const delta = choice?.delta
      if (delta?.reasoning_details?.length) mergeReasoningDetails(reasoningDetails, delta.reasoning_details)
      if (delta) {
        // Newer vLLM streams `reasoning`, older servers `reasoning_content`; one server may send both.
        reasoningText ??= delta.reasoning
          ? { field: 'reasoning', text: '' }
          : delta.reasoning_content
            ? { field: 'reasoning_content', text: '' }
            : null
        if (reasoningText) reasoningText.text += delta[reasoningText.field] ?? ''
      }
      if (delta?.content) {
        text += delta.content
        yield { type: 'text_delta', text: delta.content }
      }
      for (const tc of delta?.tool_calls ?? []) {
        const entry = calls.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name += tc.function.name
        if (tc.function?.arguments) entry.args += tc.function.arguments
        calls.set(tc.index, entry)
        if (tc.function?.arguments && entry.name) {
          yield {
            type: 'tool_input_delta',
            id: entry.id || `call_${tc.index}`,
            name: entry.name,
            partialJson: entry.args,
          }
        }
      }
      if (chunks.length < 2000) chunks.push(chunk)
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({
        id: c.id || `call_${index}`,
        name: c.name,
        arguments: parseToolArguments(c.args),
      }))
    for (const call of toolCalls) yield { type: 'tool_call', call }

    const message: AssistantMessage = {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoningDetails.length
        ? { providerData: { type: 'openai_compatible' as const, content: reasoningDetails } }
        : reasoningText?.text
          ? { providerData: { type: 'openai_compatible' as const, content: reasoningText } }
          : {}),
    }
    const prices = this.options.prices?.(request.model) ?? null
    yield {
      type: 'done',
      result: {
        message,
        stopReason: mapFinish(finish, toolCalls.length > 0),
        usage: usageWithCost(normalizeOpenAIUsage(usage), usage?.cost, prices),
        generationId,
        rawRequest,
        rawResponse: { id: generationId, model, finishReason: finish, text, toolCalls, usage },
        latencyMs: Date.now() - started,
      },
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const res = await this.doFetch(`${this.baseUrl}/models`, { headers: this.headers() })
    if (!res.ok)
      throw new ProviderError(`HTTP ${res.status} listing models`, res.status, null, await res.text())
    const json = (await res.json()) as { data?: OpenRouterModel[] }
    const chat = (m: OpenRouterModel) => {
      const outputs = m.architecture?.output_modalities
      if (outputs?.includes('image') || IMAGE_ONLY_ID.test(m.id)) return false
      return !outputs || outputs.includes('text') || !outputs.includes('embeddings')
    }
    return (json.data ?? []).filter(chat).map((m) => {
      const params = m.supported_parameters
      const modalities = m.architecture?.input_modalities
      return discoveredChatModel(
        {
          modelId: m.id,
          displayName: m.name ?? m.id,
          supportsTools: params ? params.includes('tools') : true,
          supportsVision: modalities ? modalities.includes('image') : true,
          contextWindow: positiveInt(m.context_length) ?? positiveInt(m.top_provider?.context_length),
          maxOutputTokens: positiveInt(m.top_provider?.max_completion_tokens),
          efforts: listedEfforts(params),
          source: 'fetched',
        },
        {
          priceInputPerMtokUsd: perMillion(m.pricing?.prompt),
          priceOutputPerMtokUsd: perMillion(m.pricing?.completion),
          priceCacheReadPerMtokUsd: perMillion(m.pricing?.input_cache_read),
          priceCacheWritePerMtokUsd: perMillion(m.pricing?.input_cache_write),
          pricePerRequestUsd:
            m.pricing?.request && Number(m.pricing.request) > 0 ? Number(m.pricing.request) : null,
        },
      )
    })
  }

  async testConnection(model: string): Promise<ConnectionTestResult> {
    return testWithToolAndImage(this, model)
  }
}
