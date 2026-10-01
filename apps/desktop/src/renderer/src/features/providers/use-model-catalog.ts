import { type ModelChoice, type ProviderType, type ReasoningEffort } from '@milibot/shared'

import { useProvidersData } from '@/features/providers/api'
import { chatModelChoices } from '@/features/providers/lib/models'
import { useAppStore } from '@/features/workspace/store'

/** A chat model any bot could run on, with its provider. */
export interface CatalogModel {
  providerId: string
  providerName: string
  providerType: ProviderType
  id: string
  displayName: string
  contextWindow: number | null
  efforts: readonly ReasoningEffort[] | null
  defaultEffort: ReasoningEffort | null
}

/** Every provider's chat models (the CLI engines' catalogs, the others' enabled models). */
export function useModelCatalog(): CatalogModel[] {
  const workspaceId = useAppStore((s) => s.workspaceId)
  const { data } = useProvidersData(workspaceId)
  if (!data) return []
  return data.providers.flatMap((p) =>
    chatModelChoices(p, data.models[p.id]?.chat ?? []).map((m) => ({
      providerId: p.id,
      providerName: p.name,
      providerType: p.type,
      id: m.id,
      displayName: m.displayName,
      contextWindow: m.contextWindow ?? null,
      efforts: m.efforts ?? null,
      defaultEffort: m.defaultEffort ?? null,
    })),
  )
}

export function findCatalogModel(catalog: CatalogModel[], choice: ModelChoice | null): CatalogModel | null {
  return (choice && catalog.find((m) => m.providerId === choice.providerId && m.id === choice.model)) ?? null
}
