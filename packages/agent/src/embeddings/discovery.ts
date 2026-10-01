import { isOpenRouterServer } from '@milibot/shared'

import { apiHeaders } from '../llm/http/headers'
import { perMillion, positiveInt, shortDescription } from '../llm/http/listing'
import { type ApiEmbeddingOptions, probeEmbeddingDimensions } from './api'
import { findApiEmbeddingModel } from './catalog'
import { EmbeddingError } from './types'

export interface EmbeddingServerOptions {
  baseUrl: string
  apiKey: string | null
  preset: string | null
  extraHeaders?: Record<string, string>
  fetch?: typeof fetch
}

/** A model the server lists, as the embedding table shows it before the user adds it. */
export interface EmbeddingModelListing {
  modelId: string
  displayName: string
  description: string | null
  contextWindow: number | null
  priceInputPerMtokUsd: number | null
  dimensions: number | null
  /** The server says it embeds (OpenRouter), or the id looks like it (other servers). */
  embedding: boolean
  suggested: boolean
}

export interface EmbeddingModelList {
  models: EmbeddingModelListing[]
  /** Every model was listed as an embedding model by the server itself. */
  verified: boolean
}

export type EmbeddingProbeErrorCode =
  'unauthorized' | 'model_not_found' | 'not_embedding' | 'unreachable' | 'invalid_response' | 'provider_error'

export interface EmbeddingProbe {
  ok: boolean
  dimensions: number | null
  errorCode: EmbeddingProbeErrorCode | null
  error: string | null
}

interface ListedModel {
  id?: unknown
  name?: unknown
  description?: unknown
  context_length?: unknown
  pricing?: { prompt?: unknown }
  architecture?: { output_modalities?: unknown }
  top_provider?: { context_length?: unknown }
}

const LIST_TIMEOUT_MS = 10_000
const PROBE_TIMEOUT_MS = 30_000
/** Families of open embedding models, for servers whose `/models` does not say what a model does. */
const EMBEDDING_ID = /embed|\bbge\b|bge-|\bgte-|\be5-|minilm|mpnet/i

function headers(options: EmbeddingServerOptions): Record<string, string> {
  return apiHeaders({
    apiKey: options.apiKey,
    extraHeaders: options.extraHeaders,
    openRouter: isOpenRouterServer(options.baseUrl, options.preset),
  })
}

/** OpenRouter `/models?output_modalities=embeddings`: names, prices and context from the listing. */
export function parseOpenRouterEmbeddingModels(json: unknown): EmbeddingModelListing[] {
  const data = (json as { data?: ListedModel[] } | null)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((m): EmbeddingModelListing[] => {
    if (typeof m.id !== 'string' || !m.id) return []
    const outputs = m.architecture?.output_modalities
    if (Array.isArray(outputs) && !outputs.includes('embeddings')) return []
    return [
      {
        modelId: m.id,
        displayName: typeof m.name === 'string' && m.name ? m.name : m.id,
        description: shortDescription(m.description),
        contextWindow: positiveInt(m.context_length) ?? positiveInt(m.top_provider?.context_length),
        priceInputPerMtokUsd: perMillion(m.pricing?.prompt),
        dimensions: null,
        embedding: true,
        suggested: findApiEmbeddingModel(m.id)?.suggested ?? false,
      },
    ]
  })
}

/** Plain OpenAI-style `/models`: ids only, so `embedding` is a guess from the id. */
export function parseGenericModels(json: unknown): EmbeddingModelListing[] {
  const data = (json as { data?: ListedModel[] } | null)?.data
  if (!Array.isArray(data)) return []
  return data
    .flatMap((m): EmbeddingModelListing[] => {
      if (typeof m.id !== 'string' || !m.id) return []
      return [
        {
          modelId: m.id,
          displayName: typeof m.name === 'string' && m.name ? m.name : m.id,
          description: shortDescription(m.description),
          contextWindow: positiveInt(m.context_length),
          priceInputPerMtokUsd: perMillion(m.pricing?.prompt),
          dimensions: null,
          embedding: EMBEDDING_ID.test(m.id),
          suggested: false,
        },
      ]
    })
    .sort((a, b) => Number(b.embedding) - Number(a.embedding) || a.modelId.localeCompare(b.modelId))
}

/** Models of the server for the embedding table; OpenRouter is asked for embedding models only. */
export async function listEmbeddingModels(options: EmbeddingServerOptions): Promise<EmbeddingModelList> {
  const base = options.baseUrl.replace(/\/+$/, '')
  const openRouter = isOpenRouterServer(base, options.preset)
  const url = openRouter ? `${base}/models?output_modalities=embeddings` : `${base}/models`
  const res = await (options.fetch ?? fetch)(url, {
    headers: headers(options),
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new EmbeddingError('provider_error', `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status)
  }
  const json: unknown = await res.json().catch(() => null)
  return openRouter
    ? { models: parseOpenRouterEmbeddingModels(json), verified: true }
    : { models: parseGenericModels(json), verified: false }
}

export function probeErrorCode(err: unknown): EmbeddingProbeErrorCode {
  if (!(err instanceof EmbeddingError)) return 'provider_error'
  if (err.code === 'invalid_response') return 'invalid_response'
  if (err.code === 'aborted') return 'unreachable'
  if (err.code !== 'provider_error') return 'provider_error'
  const status = err.status
  const answered = status !== null || /^provider error:/.test(err.message)
  if (!answered) return 'unreachable'
  if (status === 401 || status === 403) return 'unauthorized'
  if (/not.?found|does not exist|no such|unknown model|invalid model|no endpoints/i.test(err.message))
    return 'model_not_found'
  if (status === 404) return 'model_not_found'
  if (status === null) return /embed/i.test(err.message) ? 'not_embedding' : 'provider_error'
  if (status === 400 || status === 405 || status === 422 || status === 501) return 'not_embedding'
  return 'provider_error'
}

/** `POST /embeddings` with a short text: whether the model embeds and its vector size. */
export async function probeEmbeddingModel(
  options: Omit<ApiEmbeddingOptions, 'providerId'> & { providerId?: string },
): Promise<EmbeddingProbe> {
  try {
    const dimensions = await probeEmbeddingDimensions(
      { providerId: 'probe', ...options },
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
    )
    return { ok: true, dimensions, errorCode: null, error: null }
  } catch (err) {
    return {
      ok: false,
      dimensions: null,
      errorCode: probeErrorCode(err),
      error: (err as Error).message.slice(0, 500),
    }
  }
}
