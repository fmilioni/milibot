import type { ProviderModel, ReasoningEffort } from '@milibot/shared'

import type { PriceTable } from './usage'

export type DiscoveredModel = Omit<ProviderModel, 'id' | 'providerId' | 'createdAt' | 'updatedAt'>

/** A chat model found by `listModels`, enabled, with its prices (all null when unknown). */
export function discoveredChatModel(
  model: Pick<
    DiscoveredModel,
    | 'modelId'
    | 'displayName'
    | 'supportsTools'
    | 'supportsVision'
    | 'contextWindow'
    | 'maxOutputTokens'
    | 'source'
  > &
    Partial<Pick<DiscoveredModel, 'efforts' | 'defaultEffort'>>,
  prices: PriceTable | null,
): DiscoveredModel {
  return {
    kind: 'chat',
    modelId: model.modelId,
    displayName: model.displayName,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    efforts: model.efforts ?? null,
    defaultEffort: model.defaultEffort ?? null,
    dimensions: null,
    priceInputPerMtokUsd: prices?.priceInputPerMtokUsd ?? null,
    priceOutputPerMtokUsd: prices?.priceOutputPerMtokUsd ?? null,
    priceCacheReadPerMtokUsd: prices?.priceCacheReadPerMtokUsd ?? null,
    priceCacheWritePerMtokUsd: prices?.priceCacheWritePerMtokUsd ?? null,
    pricePerRequestUsd: prices?.pricePerRequestUsd ?? null,
    enabled: true,
    source: model.source,
  }
}

/** What the user registered for a chat model in `provider_models` (null = unknown). */
export interface ModelLimits {
  contextWindow: number | null
  maxOutputTokens: number | null
  /** Reasoning efforts the model accepts; null/absent = unknown. */
  efforts?: ReasoningEffort[] | null
}

/** The output cap of a request, bounded by the model's registered maximum. */
export function outputCap(
  requested: number | undefined,
  limit: number | null | undefined,
): number | undefined {
  if (!limit) return requested
  return requested ? Math.min(requested, limit) : limit
}
