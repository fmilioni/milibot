import { anthropicPrices } from '@milibot/agent/llm'

import type { CachePriceLookup } from '../observability'
import type { ProviderStore } from '../providers'

/** Cache prices of a model: registered on an OpenAI-compatible provider, else Anthropic's catalog. */
export function cachePriceLookup(providers: Pick<ProviderStore, 'listModels'>): CachePriceLookup {
  return (type, providerId, model) => {
    if (type === 'openai_compatible' && providerId) {
      try {
        const row = providers.listModels(providerId).find((m) => m.modelId === model)
        if (row?.priceInputPerMtokUsd != null && row.priceCacheReadPerMtokUsd != null)
          return { input: row.priceInputPerMtokUsd, cacheRead: row.priceCacheReadPerMtokUsd }
      } catch {
        return null
      }
      return null
    }
    const prices = anthropicPrices(model)
    return prices?.priceInputPerMtokUsd != null && prices.priceCacheReadPerMtokUsd != null
      ? { input: prices.priceInputPerMtokUsd, cacheRead: prices.priceCacheReadPerMtokUsd }
      : null
  }
}
