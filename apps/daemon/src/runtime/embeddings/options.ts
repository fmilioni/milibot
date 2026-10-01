import {
  type EmbeddingSetting,
  isLocalModelDownloaded,
  LOCAL_EMBEDDING_FAMILIES,
  localEmbeddingSpaceKey,
  localModelDiskBytes,
  probeEmbeddingModel,
} from '@milibot/agent/embeddings'
import type {
  EmbeddingApiProviderOption,
  EmbeddingOptions,
  EmbeddingProbeResult,
  ProviderModel,
} from '@milibot/shared'

import type { ProviderStore } from '../providers'

export function isLoopbackUrl(url: string | null): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host)
  } catch {
    return false
  }
}

/** An enabled embedding model as an option of the knowledge settings. */
function registeredEmbeddingOption(model: ProviderModel) {
  return {
    model: model.modelId,
    name: model.displayName,
    dimensions: model.dimensions,
    maxInputTokens: model.contextWindow,
    priceInputPerMtokUsd: model.priceInputPerMtokUsd,
  }
}

/**
 * Local catalog with download state, plus every `openai_compatible` provider with the embedding models
 * registered (and enabled) in Providers and models. Nothing is fetched here: names, prices and sizes are
 * what the user saved.
 */
export async function embeddingOptions(input: {
  current: EmbeddingSetting
  modelsDir: string | null
  download: { modelId: string; progress: number } | null
  providers: ProviderStore
}): Promise<EmbeddingOptions> {
  const local = LOCAL_EMBEDDING_FAMILIES.map((family) => ({
    id: family.id,
    name: family.name,
    vendor: family.vendor,
    levels: family.levels.map((level) => ({
      id: level.id,
      dimensions: level.dimensions,
      maxInputTokens: level.model.maxInputTokens,
      ramMb: level.ramMb,
      downloadBytes: level.model.downloadBytes,
      recommended: level.recommended,
      downloaded: input.modelsDir ? isLocalModelDownloaded(input.modelsDir, level.model) : false,
      diskBytes: input.modelsDir ? localModelDiskBytes(input.modelsDir, level.model) : 0,
      downloadProgress:
        input.download && input.download.modelId.includes(level.model.repo) ? input.download.progress : null,
      spaceKey: localEmbeddingSpaceKey(level),
    })),
  }))
  const api: EmbeddingApiProviderOption[] = (await input.providers.list())
    .filter((provider) => provider.type === 'openai_compatible')
    .map((provider) => ({
      providerId: provider.id,
      name: provider.name,
      preset: provider.preset,
      local: isLoopbackUrl(provider.baseUrl),
      models: input.providers
        .listModels(provider.id, 'embedding')
        .filter((m) => m.enabled)
        .map(registeredEmbeddingOption),
    }))
  return { current: input.current, local, api }
}

/**
 * Tests a registered embedding model before it is chosen (`POST /embeddings` with a short text) and
 * stores its vector size, so the select can show it and the index knows its space.
 */
export async function probeRegisteredEmbedding(input: {
  providers: ProviderStore
  providerId: string
  model: string
  fetch?: typeof fetch
}): Promise<EmbeddingProbeResult> {
  const registered = input.providers.embeddingModel(input.providerId, input.model)
  if (!registered) {
    return {
      ok: false,
      dimensions: null,
      errorCode: 'model_not_found',
      error: `${input.model} is not registered in Providers and models`,
    }
  }
  const result = await probeEmbeddingModel({
    ...(await input.providers.server(input.providerId)),
    providerId: input.providerId,
    model: input.model,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  })
  if (result.ok && result.dimensions)
    input.providers.setEmbeddingDimensions(input.providerId, input.model, result.dimensions)
  return result
}
