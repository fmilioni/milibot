import { isCliEngine } from '@milibot/shared'

import { useProviderModelLists, useProviders } from '@/features/providers/api'
import { EMPTY_MODELS, modelsOf, type ProviderModels } from '@/features/providers/lib/models'
import { useAppStore } from '@/features/workspace/store'

/** Provider of a bot (its own, else the workspace default) and the models it offers. */
export function useProviderModels(providerId: string | null | undefined): ProviderModels {
  const workspaceId = useAppStore((s) => s.workspaceId)
  const providers = useProviders(workspaceId).data ?? []
  const provider =
    providers.find((p) => p.id === providerId) ?? providers.find((p) => p.isDefault) ?? providers[0] ?? null
  const lists = useProviderModelLists(workspaceId ?? '', provider).data
  if (!provider || (!lists && !isCliEngine(provider.type))) return EMPTY_MODELS
  return modelsOf(provider, lists?.chat ?? [])
}
