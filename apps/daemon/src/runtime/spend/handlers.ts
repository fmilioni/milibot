import type { costEndpoints } from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'
import type { CostStore } from '../observability'
import type { ProviderStore } from '../providers'
import { cachePriceLookup } from './cache-prices'
import type { SpendGuard } from './guard'

/** The cost screen and the daily limits (resetting the sidebar counter is the workspace status's). */
export class SpendRoutes {
  constructor(
    private readonly deps: {
      spend: SpendGuard
      costs: CostStore
      providers: Pick<ProviderStore, 'listModels'>
    },
  ) {}

  handlers(): EndpointHandlers<Exclude<keyof typeof costEndpoints, 'resetUsageCounter'>> {
    const { spend, costs } = this.deps
    const prices = cachePriceLookup(this.deps.providers)
    return {
      getCostSummary: ({ query }) => costs.summary(query),
      getCostOverview: ({ query }) => costs.overview(query.days, prices),
      getSpendStatus: () => spend.status(),
      resumeSpend: () => spend.resume(),
    }
  }
}
