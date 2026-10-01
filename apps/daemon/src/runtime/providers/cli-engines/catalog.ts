import type { DiscoveredModel } from '@milibot/agent/llm'
import { CLI_ENGINE_INFO, type CliEngine } from '@milibot/shared'

/** An engine's fixed catalog (`CLI_ENGINE_INFO.models`) with its prices, for engines that report no cost. */
export function cliCatalogModels(engine: CliEngine): DiscoveredModel[] {
  return CLI_ENGINE_INFO[engine].models.map((m) => ({
    kind: 'chat' as const,
    modelId: m.id,
    displayName: m.displayName,
    supportsTools: true,
    supportsVision: true,
    contextWindow: m.contextWindow,
    maxOutputTokens: null,
    efforts: [...m.efforts],
    defaultEffort: null,
    dimensions: null,
    priceInputPerMtokUsd: m.input ?? null,
    priceOutputPerMtokUsd: m.output ?? null,
    priceCacheReadPerMtokUsd: m.cacheRead ?? null,
    priceCacheWritePerMtokUsd: m.input ?? null,
    pricePerRequestUsd: null,
    enabled: true,
    source: 'builtin' as const,
  }))
}
