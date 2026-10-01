import Anthropic from '@anthropic-ai/sdk'
import {
  isStandardEffort,
  pickEffort,
  type ProviderType,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@milibot/shared'

import { parseToolArguments } from '../tools/args'
import { blobRef, inlineBlobs } from './blobs'
import { testWithToolAndImage } from './connection-test'
import {
  type AssistantMessage,
  type ChatMessage,
  type ContentPart,
  systemCacheParts,
  textOfParts,
  type ToolCall,
} from './messages'
import { discoveredChatModel, type DiscoveredModel, type ModelLimits, outputCap } from './models'
import { ANTHROPIC_PRICES, anthropicModelInfo, anthropicPrices } from './pricing'
import {
  type CompletionRequest,
  type ConnectionTestResult,
  type LLMProvider,
  ProviderError,
  type StopReason,
  type StreamChunk,
} from './provider'
import { toAnthropicTool } from './tool-schema'
import { type PriceTable, usageWithCost } from './usage'

export interface AnthropicProviderOptions {
  id: string
  apiKey: string | null
  /** Bearer token (gateways); used when no API key is set. */
  authToken?: string | null
  baseUrl?: string | null
  /** Overrides from `provider_models`; falls back to the built-in table. */
  prices?: (model: string) => PriceTable | null
  /** Registered context and output cap of a model (`provider_models`). */
  limits?: (model: string) => ModelLimits | null
  client?: Anthropic
}

const EPHEMERAL = { type: 'ephemeral' as const }

type Block = Anthropic.ContentBlockParam

function toBlocks(parts: ContentPart[]): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: p.mediaType, data: blobRef(p.sha256) },
        },
  )
}

/**
 * Cache breakpoints: the system parts flagged `cacheBreakpoint` (stable prompt, then memory and
 * summaries; tools render before the system so they are covered) or the end of the system when
 * none is flagged, plus the last block of the conversation so each tool-loop step reads the
 * previous prefix. At most 3 of the 4 allowed.
 */
export function toAnthropicParams(
  request: CompletionRequest,
  efforts?: readonly ReasoningEffort[] | null,
): Anthropic.MessageCreateParamsNonStreaming {
  const info = anthropicModelInfo(request.model)
  // The Messages API only takes the standard levels.
  const picked = pickEffort(request.effort, efforts ?? info?.efforts ?? null)
  const effort = picked && isStandardEffort(picked) ? picked : null
  const system: Anthropic.TextBlockParam[] = systemCacheParts(request.messages).map((p) => ({
    type: 'text',
    text: p.text,
    ...(p.breakpoint ? { cache_control: EPHEMERAL } : {}),
  }))
  const messages: Anthropic.MessageParam[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = messages.at(-1)
    if (last && last.role === role && Array.isArray(last.content)) (last.content as Block[]).push(...blocks)
    else messages.push({ role, content: blocks })
  }
  for (const message of request.messages as ChatMessage[]) {
    switch (message.role) {
      case 'system':
        break
      case 'user':
        push('user', toBlocks(message.content))
        break
      case 'assistant': {
        if (message.providerData?.type === 'anthropic' && Array.isArray(message.providerData.content)) {
          push('assistant', message.providerData.content as Block[])
          break
        }
        const blocks: Block[] = []
        const text = textOfParts(message.content, '\n\n')
        if (text) blocks.push({ type: 'text', text })
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} })
        }
        if (blocks.length) push('assistant', blocks)
        break
      }
      case 'tool':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: toBlocks(
              message.content.length ? message.content : [{ type: 'text', text: '(no output)' }],
            ),
            ...(message.isError ? { is_error: true } : {}),
          },
        ])
        break
    }
  }
  if (messages[0]?.role !== 'user')
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] })
  const last = messages.at(-1)
  if (last && Array.isArray(last.content) && last.content.length) {
    const block = last.content.at(-1) as Block & { cache_control?: unknown }
    if (block.type !== 'thinking' && block.type !== 'redacted_thinking') block.cache_control = EPHEMERAL
  }
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 32_000,
    ...(effort ? { output_config: { effort } } : {}),
    ...(effort && effort !== 'low' && info?.adaptiveThinking === 'opt_in'
      ? { thinking: { type: 'adaptive' as const } }
      : {}),
    ...(system.length ? { system } : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool): Anthropic.Tool => ({
            ...(toAnthropicTool(tool) as Anthropic.Tool),
            ...(tool.streamInput ? { eager_input_streaming: true } : {}),
          })),
          ...(request.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}),
        }
      : {}),
    messages,
  }
}

/**
 * With eager input streaming the API no longer validates tool input (a call cut by `max_tokens` would arrive
 * as a truncated object): the input of those tools is read strictly from what was streamed.
 */
function toolInput(
  block: Anthropic.ToolUseBlock,
  request: CompletionRequest,
  streamed: ReadonlyMap<number, { id: string; json: string }>,
): unknown {
  if (!request.tools.some((tool) => tool.name === block.name && tool.streamInput)) return block.input
  const raw = [...streamed.values()].find((input) => input.id === block.id)?.json
  return raw === undefined ? block.input : parseToolArguments(raw)
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly type: ProviderType = 'anthropic'
  readonly id: string
  private readonly client: Anthropic

  constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey ?? null,
        authToken: options.apiKey ? null : (options.authToken ?? null),
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        maxRetries: 2,
      })
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    const limits = this.options.limits?.(request.model)
    const rawRequest = toAnthropicParams(
      {
        ...request,
        maxOutputTokens: outputCap(request.maxOutputTokens ?? undefined, limits?.maxOutputTokens),
      },
      limits?.efforts,
    )
    const params = await inlineBlobs(rawRequest, request.blobs)
    const started = Date.now()
    let final: Anthropic.Message
    const toolInputs = new Map<number, { id: string; name: string; json: string }>()
    try {
      const stream = this.client.messages.stream(params, { signal: request.signal })
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          toolInputs.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: '',
          })
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          const input = toolInputs.get(event.index)
          if (input && event.delta.partial_json) {
            input.json += event.delta.partial_json
            yield { type: 'tool_input_delta', id: input.id, name: input.name, partialJson: input.json }
          }
        }
      }
      final = await stream.finalMessage()
    } catch (err) {
      if (request.signal?.aborted) throw err
      const status = err instanceof Anthropic.APIError ? (err.status ?? null) : null
      throw new ProviderError((err as Error).message, status, rawRequest)
    }

    const toolCalls: ToolCall[] = []
    let text = ''
    for (const block of final.content) {
      if (block.type === 'text') text += block.text
      if (block.type === 'tool_use')
        toolCalls.push({ id: block.id, name: block.name, arguments: toolInput(block, request, toolInputs) })
    }
    for (const call of toolCalls) yield { type: 'tool_call', call }

    const u = final.usage
    const reasoning = u.output_tokens_details?.thinking_tokens ?? 0
    const tokens = {
      inputTokens: u.input_tokens,
      cachedReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      outputTokens: Math.max(0, u.output_tokens - reasoning),
      reasoningTokens: reasoning,
    }
    const prices = this.options.prices?.(request.model) ?? anthropicPrices(request.model)
    const message: AssistantMessage = {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      ...(toolCalls.length ? { toolCalls } : {}),
      providerData: { type: 'anthropic', content: final.content },
    }
    yield {
      type: 'done',
      result: {
        message,
        stopReason: mapStop(final.stop_reason),
        usage: usageWithCost(tokens, null, prices),
        generationId: final.id,
        rawRequest,
        rawResponse: final,
        latencyMs: Date.now() - started,
      },
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const listed = new Map<string, Anthropic.ModelInfo | null>()
    try {
      for await (const model of this.client.models.list()) listed.set(model.id, model)
    } catch {
      for (const id of Object.keys(ANTHROPIC_PRICES)) listed.set(id, null)
    }
    return [...listed].map(([modelId, api]) => {
      const prices = anthropicPrices(modelId)
      const info = anthropicModelInfo(modelId)
      return discoveredChatModel(
        {
          modelId,
          displayName: api?.display_name ?? info?.displayName ?? modelId,
          supportsTools: true,
          supportsVision: true,
          contextWindow: api?.max_input_tokens ?? info?.contextWindow ?? null,
          maxOutputTokens: api?.max_tokens ?? info?.maxOutputTokens ?? null,
          efforts: apiEfforts(api) ?? info?.efforts ?? null,
          source: prices ? 'builtin' : 'fetched',
        },
        prices,
      )
    })
  }

  async testConnection(model: string): Promise<ConnectionTestResult> {
    return testWithToolAndImage(this, model)
  }
}

/** Effort levels the Models API says a model accepts (null when it does not say). */
function apiEfforts(model: Anthropic.ModelInfo | null): ReasoningEffort[] | null {
  const effort = model?.capabilities?.effort
  if (!effort) return null
  if (!effort.supported) return []
  return REASONING_EFFORTS.filter((level) => effort[level]?.supported)
}
