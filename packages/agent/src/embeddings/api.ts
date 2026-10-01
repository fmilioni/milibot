import { estimateTokens } from '@milibot/shared'

import { apiHeaders } from '../llm/http/headers'
import { abortableSleep } from '../llm/http/sleep'
import { apiEmbeddingSpaceKey, findApiEmbeddingModel } from './catalog'
import type { EmbeddingKind, EmbeddingProvider, EmbeddingResult } from './types'
import { EmbeddingError } from './types'
import { normalize } from './vector'

export interface ApiEmbeddingOptions {
  /** Row id in `providers`; part of the space key. */
  providerId: string
  /** OpenAI-style base URL (`…/v1`, OpenRouter `https://openrouter.ai/api/v1`); `/embeddings` is appended. */
  baseUrl: string
  apiKey: string | null
  model: string
  extraHeaders?: Record<string, string>
  /** `openrouter` adds the attribution headers, like the chat provider. */
  preset?: string | null
  /**
   * Requested output size, sent as `dimensions` (models with Matryoshka support, e.g. OpenAI
   * text-embedding-3, Qwen3). Null/absent = the model's native size.
   */
  dimensions?: number | null
  /**
   * Native output size when `dimensions` is not requested (the registered model's, once tested).
   * Unknown: use `createApiEmbeddingProvider`, which detects it with one call.
   */
  nativeDimensions?: number | null
  maxInputTokens?: number
  queryPrefix?: string
  documentPrefix?: string
  /** The registered price; used when the response has no `usage.cost` (OpenRouter reports it). */
  priceInputPerMtokUsd?: number | null
  /** Inputs per request (default 64). */
  batchSize?: number
  /** Retries on network errors, 408, 429 and 5xx (default 4). */
  maxRetries?: number
  fetch?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] | string; index?: number }>
  usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number }
  error?: { message?: string; code?: number | string }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529])

function abortError(): EmbeddingError {
  return new EmbeddingError('aborted', 'embedding aborted')
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return abortableSleep(ms, signal, abortError)
}

function decodeBase64Floats(value: string): number[] {
  const bytes = Buffer.from(value, 'base64')
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)))
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000)
  return Math.min(30_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5)
}

function requestHeaders(options: ApiEmbeddingOptions): Record<string, string> {
  return apiHeaders({
    apiKey: options.apiKey,
    extraHeaders: options.extraHeaders,
    json: true,
    openRouter: options.preset === 'openrouter',
  })
}

interface BatchResult {
  vectors: Float32Array[]
  tokens: number
  /** `usage.cost` when the provider reports it. */
  cost: number | null
}

/** One `/embeddings` call with retries. `expectedDimensions` null accepts any (consistent) size. */
async function postEmbeddings(
  options: ApiEmbeddingOptions,
  input: string[],
  expectedDimensions: number | null,
  signal?: AbortSignal,
): Promise<BatchResult> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/embeddings`
  const doFetch = options.fetch ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const body = JSON.stringify({
    model: options.model,
    input,
    encoding_format: 'float',
    ...(options.dimensions ? { dimensions: options.dimensions } : {}),
  })
  const maxRetries = options.maxRetries ?? 4
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError()
    let res: Response
    try {
      res = await doFetch(url, { method: 'POST', headers: requestHeaders(options), body, signal })
    } catch (err) {
      if (signal?.aborted) throw abortError()
      if (attempt >= maxRetries) {
        throw new EmbeddingError('provider_error', `embedding request failed: ${(err as Error).message}`)
      }
      await sleep(backoffMs(attempt, null), signal)
      continue
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(backoffMs(attempt, res.headers.get('retry-after')), signal)
        continue
      }
      throw new EmbeddingError('provider_error', `HTTP ${res.status}: ${text.slice(0, 1000)}`, res.status)
    }
    const json = (await res.json().catch(() => null)) as EmbeddingsResponse | null
    if (json?.error) {
      throw new EmbeddingError('provider_error', `provider error: ${json.error.message ?? 'unknown'}`)
    }
    return parseEmbeddings(json, input, expectedDimensions)
  }
}

function parseEmbeddings(
  json: EmbeddingsResponse | null,
  input: string[],
  expectedDimensions: number | null,
): BatchResult {
  const data = json?.data
  if (!Array.isArray(data) || data.length !== input.length) {
    throw new EmbeddingError(
      'invalid_response',
      `expected ${input.length} embeddings, got ${Array.isArray(data) ? data.length : 'none'}`,
    )
  }
  let dims = expectedDimensions
  const vectors = [...data]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => {
      const raw = typeof item.embedding === 'string' ? decodeBase64Floats(item.embedding) : item.embedding
      const length = Array.isArray(raw) ? raw.length : 0
      dims ??= length
      if (!Array.isArray(raw) || length === 0 || length !== dims) {
        throw new EmbeddingError('invalid_response', `embedding has ${length} dimensions, expected ${dims}`)
      }
      return normalize(raw)
    })
  const usage = json?.usage
  const tokens =
    usage?.prompt_tokens ?? usage?.total_tokens ?? input.reduce((s, t) => s + estimateTokens(t), 0)
  return { vectors, tokens, cost: typeof usage?.cost === 'number' ? usage.cost : null }
}

/** `POST {baseUrl}/embeddings` of any OpenAI-compatible provider (OpenRouter, OpenAI, Ollama, LM Studio…). */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly key: string
  readonly dimensions: number
  readonly maxInputTokens: number
  private readonly queryPrefix: string
  private readonly documentPrefix: string

  constructor(private readonly options: ApiEmbeddingOptions) {
    const known = findApiEmbeddingModel(options.model)
    const dimensions = options.dimensions ?? options.nativeDimensions
    if (!dimensions) {
      throw new EmbeddingError(
        'invalid_setting',
        `unknown output size for ${options.model}; pass dimensions or use createApiEmbeddingProvider`,
      )
    }
    this.dimensions = dimensions
    this.maxInputTokens = options.maxInputTokens ?? known?.maxInputTokens ?? 8192
    this.queryPrefix = options.queryPrefix ?? known?.queryPrefix ?? ''
    this.documentPrefix = options.documentPrefix ?? known?.documentPrefix ?? ''
    this.key = apiEmbeddingSpaceKey(options.providerId, options.model, dimensions)
  }

  /**
   * `usage.costUsd`: the sum of `usage.cost` when every response reported it (OpenRouter), otherwise
   * tokens × `priceInputPerMtokUsd`, otherwise absent.
   */
  async embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<EmbeddingResult> {
    const prefix = kind === 'query' ? this.queryPrefix : this.documentPrefix
    const batchSize = Math.max(1, this.options.batchSize ?? 64)
    const vectors: Float32Array[] = []
    let tokens = 0
    let reportedCost = 0
    let allReported = true
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize).map((t) => prefix + t)
      const res = await postEmbeddings(this.options, batch, this.dimensions, signal)
      vectors.push(...res.vectors)
      tokens += res.tokens
      if (res.cost === null) allReported = false
      else reportedCost += res.cost
    }
    const price = this.options.priceInputPerMtokUsd
    const costUsd =
      texts.length > 0 && allReported
        ? reportedCost
        : price !== null && price !== undefined
          ? (tokens * price) / 1e6
          : undefined
    return { vectors, usage: { tokens, ...(costUsd !== undefined ? { costUsd } : {}) } }
  }
}

/** One short `/embeddings` call (no retries): the model answers, and with how many dimensions. */
export async function probeEmbeddingDimensions(
  options: ApiEmbeddingOptions,
  signal?: AbortSignal,
): Promise<number> {
  const probe = await postEmbeddings({ ...options, maxRetries: 0 }, ['dimension probe'], null, signal)
  return probe.vectors[0]!.length
}

/**
 * Builds the provider; when the output size is not known yet (a model never tested), one tiny
 * request detects it.
 */
export async function createApiEmbeddingProvider(
  options: ApiEmbeddingOptions,
  signal?: AbortSignal,
): Promise<ApiEmbeddingProvider> {
  if (options.dimensions || options.nativeDimensions) return new ApiEmbeddingProvider(options)
  const probe = await postEmbeddings(options, ['dimension probe'], null, signal)
  return new ApiEmbeddingProvider({ ...options, nativeDimensions: probe.vectors[0]!.length })
}
