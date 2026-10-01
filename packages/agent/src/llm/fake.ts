import { estimateTokens, type ProviderType } from '@milibot/shared'

import { messagesTokens } from '../memory/tokens'
import { abortableSleep } from './http/sleep'
import type { AssistantMessage, ToolCall } from './messages'
import type { DiscoveredModel } from './models'
import {
  type CompletionRequest,
  type ConnectionTestResult,
  type LLMProvider,
  ProviderError,
  type StreamChunk,
} from './provider'
import { EMPTY_TOKENS, type PriceTable, type TokenUsage, usageWithCost } from './usage'

export interface FakeStep {
  text?: string
  toolCalls?: Array<{ name: string; arguments?: unknown; id?: string }>
  usage?: Partial<TokenUsage>
  /** Simulated latency before the response starts. */
  delayMs?: number
  /** Makes this call fail with a ProviderError. */
  error?: string
  pieceDelayMs?: number
  /** List scripts: only a request whose system prompt contains it takes this step (side calls beside the turn). */
  when?: string
}

export type FakeScript = FakeStep[] | ((request: CompletionRequest, callIndex: number) => FakeStep)

export interface FakeProviderOptions {
  id?: string
  type?: ProviderType
  script: FakeScript
  prices?: PriceTable | null
  /** Response once a list script is exhausted. */
  fallback?: FakeStep
}

/** Deterministic provider for tests and scripted runs (`MILIBOT_FAKE_LLM`). */
export class FakeProvider implements LLMProvider {
  readonly id: string
  readonly type: ProviderType
  readonly requests: CompletionRequest[] = []
  private calls = 0
  private readonly used = new Set<number>()

  constructor(private readonly options: FakeProviderOptions) {
    this.id = options.id ?? 'fake'
    this.type = options.type ?? 'openai_compatible'
  }

  private next(request: CompletionRequest): FakeStep {
    const index = this.calls++
    const { script } = this.options
    if (typeof script === 'function') return script(request, index)
    const system = request.messages
      .filter((m) => m.role === 'system')
      .flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')))
      .join('\n')
    const free = (i: number) => !this.used.has(i)
    let pick = script.findIndex((step, i) => free(i) && step.when !== undefined && system.includes(step.when))
    if (pick < 0) pick = script.findIndex((step, i) => free(i) && step.when === undefined)
    if (pick < 0) return this.options.fallback ?? { text: 'Done.' }
    this.used.add(pick)
    return script[pick] as FakeStep
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    this.requests.push(request)
    const step = this.next(request)
    const rawRequest = {
      model: request.model,
      messages: request.messages,
      tools: request.tools.map((t) => t.name),
    }
    if (step.delayMs) await abortableSleep(step.delayMs, request.signal)
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('aborted')
    if (step.error) throw new ProviderError(step.error, 500, rawRequest)
    const text = step.text ?? ''
    for (const piece of text.match(/.{1,12}/gs) ?? []) {
      if (step.pieceDelayMs) await abortableSleep(step.pieceDelayMs, request.signal)
      yield { type: 'text_delta', text: piece }
    }
    const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((call, i) => ({
      id: call.id ?? `fake_call_${this.calls}_${i}`,
      name: call.name,
      arguments: call.arguments ?? {},
    }))
    for (const call of toolCalls) yield { type: 'tool_call', call }
    const message: AssistantMessage = {
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      ...(toolCalls.length ? { toolCalls } : {}),
    }
    const tokens = {
      ...EMPTY_TOKENS,
      // Like a real provider, bill the whole prompt (estimated).
      inputTokens: messagesTokens(request.messages) + estimateTokens(JSON.stringify(request.tools)),
      outputTokens: Math.ceil(text.length / 4),
      ...step.usage,
    }
    yield {
      type: 'done',
      result: {
        message,
        stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
        usage: usageWithCost(tokens, null, this.options.prices ?? null),
        generationId: `fake-${this.calls}`,
        rawRequest,
        rawResponse: { text, toolCalls },
        latencyMs: step.delayMs ?? 0,
      },
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    return [
      {
        kind: 'chat',
        modelId: 'fake-model',
        displayName: 'Fake model',
        supportsTools: true,
        supportsVision: true,
        contextWindow: 100_000,
        maxOutputTokens: null,
        efforts: null,
        defaultEffort: null,
        dimensions: null,
        priceInputPerMtokUsd: null,
        priceOutputPerMtokUsd: null,
        priceCacheReadPerMtokUsd: null,
        priceCacheWritePerMtokUsd: null,
        pricePerRequestUsd: null,
        enabled: true,
        source: 'manual',
      },
    ]
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, supportsTools: true, supportsVision: true, error: null }
  }
}
