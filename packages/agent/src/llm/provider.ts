import type { LlmCallUsage, ProviderType, ReasoningEffort } from '@milibot/shared'

import type { BlobReader } from './blobs'
import type { AssistantMessage, ChatMessage, ToolCall } from './messages'
import type { DiscoveredModel } from './models'

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>
  /**
   * The input is shown while the model writes it: providers that buffer tool input by default stream it
   * unbuffered (and then no longer validate it).
   */
  streamInput?: boolean
}

export interface CompletionRequest {
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  blobs: BlobReader
  maxOutputTokens?: number
  /** Reasoning effort asked for; each provider sends the nearest level the model accepts, or nothing. */
  effort?: ReasoningEffort | null
  /** 'none' keeps the tools declared (the history may hold tool calls) but forbids calling them. */
  toolChoice?: 'none'
  signal?: AbortSignal
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error'

export interface CompletionResult {
  message: AssistantMessage
  stopReason: StopReason
  usage: LlmCallUsage
  /** Provider-side id (e.g. OpenRouter generation id) for reconciliation. */
  generationId: string | null
  /** Request as sent, with images as `milibot-blob:<sha>` references. */
  rawRequest: unknown
  rawResponse: unknown
  latencyMs: number
}

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  /** Arguments of a tool call as they stream (`partialJson` = all the JSON text so far, possibly cut). */
  | { type: 'tool_input_delta'; id: string; name: string; partialJson: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; result: CompletionResult }

export interface ConnectionTestResult {
  ok: boolean
  supportsTools: boolean
  supportsVision: boolean
  error: string | null
}

export interface LLMProvider {
  readonly id: string
  readonly type: ProviderType
  listModels(): Promise<DiscoveredModel[]>
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>
  testConnection(model: string): Promise<ConnectionTestResult>
}

/** Thrown by providers; carries the (blob-referenced) request so the failed call is still logged. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly rawRequest: unknown,
    readonly rawResponse: unknown = null,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export async function complete(
  provider: LLMProvider,
  request: CompletionRequest,
  onText?: (delta: string) => void,
): Promise<CompletionResult> {
  for await (const chunk of provider.stream(request)) {
    if (chunk.type === 'done') return chunk.result
    if (chunk.type === 'text_delta') onText?.(chunk.text)
  }
  throw new ProviderError('stream ended without a result', null, null)
}
