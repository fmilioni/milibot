import { type cliEndpoints, isCliEngine } from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'
import type { CliPlanTracker, ProviderStore } from '../providers'

/** Subscription quota and plan of every CLI engine provider. */
export class CliUsageRoutes {
  constructor(private readonly deps: { providers: ProviderStore; plans: CliPlanTracker }) {}

  handlers(): EndpointHandlers<keyof typeof cliEndpoints> {
    const { providers, plans } = this.deps
    return {
      getCliUsage: async () =>
        (await providers.list()).filter((p) => isCliEngine(p.type)).flatMap((p) => plans.usage(p.id) ?? []),
    }
  }
}
