import {
  CLI_ENGINE_INFO,
  type CliEngine,
  type CreateProviderBody,
  isCliEngine,
  type Provider,
  type ProviderDraft,
  type ProviderModel,
  type UpdateProviderBody,
} from '@milibot/shared'
import { type QueryClient, type QueryObserverResult, useQueries, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { api } from '@/api/daemon'
import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { cliProviderBody } from '@/features/providers/lib/provider-form'

export interface ProviderModelLists {
  chat: ProviderModel[]
  /** Embedding models of the OpenAI-compatible providers ("Search models"). */
  embedding: ProviderModel[]
  image: ProviderModel[]
}

export const NO_MODEL_LISTS: ProviderModelLists = { chat: [], embedding: [], image: [] }

/** A provider's saved chat, search and image models (a CLI engine's chat models are its fixed catalog). */
async function fetchProviderModels(workspaceId: string, provider: Provider): Promise<ProviderModelLists> {
  const list = (kind: 'chat' | 'embedding' | 'image') =>
    api().call('listProviderModels', { params: { workspaceId, providerId: provider.id }, query: { kind } })
  const compatible = provider.type === 'openai_compatible'
  const cli = isCliEngine(provider.type) ? CLI_ENGINE_INFO[provider.type] : null
  // An engine that draws with its subscription has its one image model listed with the others.
  const [chat, embedding, image] = await Promise.all([
    cli ? [] : list('chat'),
    compatible ? list('embedding') : [],
    compatible || cli?.subscriptionImages ? list('image') : [],
  ])
  return { chat, embedding, image }
}

const listProviders = (workspaceId: string) => api().call('listProviders', { params: { workspaceId } })

/** The workspace's providers: the one query every screen reads (provider mutations invalidate it). */
export function useProviders(workspaceId: string | null) {
  return useApiQuery(queryKeys.providers(workspaceId ?? ''), () => listProviders(workspaceId ?? ''), {
    enabled: Boolean(workspaceId),
  })
}

/** Reads the providers again now (every `useProviders` follows) and resolves to the fresh list. */
export function refreshProviders(client: QueryClient, workspaceId: string): Promise<Provider[]> {
  return client.fetchQuery({
    queryKey: queryKeys.providers(workspaceId),
    queryFn: () => listProviders(workspaceId),
    staleTime: 0,
  })
}

export function useProviderModelLists(workspaceId: string, provider: Provider | null) {
  return useApiQuery(
    queryKeys.providerModels(workspaceId, provider?.id ?? ''),
    () => (provider ? fetchProviderModels(workspaceId, provider) : Promise.resolve(NO_MODEL_LISTS)),
    { enabled: Boolean(provider) },
  )
}

export interface ProvidersData {
  providers: Provider[]
  models: Record<string, ProviderModelLists>
}

function combineLists(results: QueryObserverResult<ProviderModelLists>[]) {
  return {
    lists: results.map((r) => r.data),
    error: results.find((r) => r.error)?.error ?? null,
  }
}

/** Every provider with its saved models; null until all of them arrived. */
export function useProvidersData(workspaceId: string | null): {
  data: ProvidersData | null
  error: unknown
  reload: () => void
} {
  const providers = useProviders(workspaceId)
  const list = providers.data ?? []
  const { lists, error } = useQueries({
    queries: list.map((provider) => ({
      queryKey: queryKeys.providerModels(workspaceId ?? '', provider.id),
      queryFn: () => fetchProviderModels(workspaceId ?? '', provider),
      enabled: Boolean(workspaceId),
    })),
    combine: combineLists,
  })
  const data = useMemo(() => {
    if (!providers.data || !lists.every(Boolean)) return null
    return {
      providers: providers.data,
      models: Object.fromEntries(providers.data.map((p, i) => [p.id, lists[i] as ProviderModelLists])),
    }
  }, [providers.data, lists])
  const client = useQueryClient()
  const reload = useCallback(
    () => void client.invalidateQueries({ queryKey: queryKeys.providers(workspaceId ?? '') }),
    [client, workspaceId],
  )
  return { data, error: providers.error ?? error, reload }
}

export const createProvider = (workspaceId: string, body: CreateProviderBody) =>
  api().call('createProvider', { params: { workspaceId }, body })

export const addCliProvider = (workspaceId: string, engine: CliEngine) =>
  createProvider(workspaceId, cliProviderBody(engine))

export const updateProvider = (workspaceId: string, providerId: string, body: UpdateProviderBody) =>
  api().call('updateProvider', { params: { workspaceId, providerId }, body })

export const deleteProvider = (workspaceId: string, providerId: string) =>
  api().call('deleteProvider', { params: { workspaceId, providerId } })

export const checkProvider = (workspaceId: string, providerId: string) =>
  api().call('testProvider', { params: { workspaceId, providerId }, body: {} })

export const getProviderAccount = (workspaceId: string, providerId: string) =>
  api().call('getProviderAccount', { params: { workspaceId, providerId } })

export const getAutomaticModels = (workspaceId: string) =>
  api().call('getAutomaticModels', { params: { workspaceId } })

export const getCliInstall = (workspaceId: string, engine: CliEngine) =>
  api().call('getCliInstall', { params: { workspaceId, engine } })

export const installCli = (workspaceId: string, engine: CliEngine) =>
  api().call('installCli', { params: { workspaceId, engine } })

export const getCliLoginStatus = (workspaceId: string, engine: CliEngine) =>
  api().call('getCliLoginStatus', { params: { workspaceId, engine } })

/** Opens the engine's login in a terminal on a bot's screen (the first bot's when given). */
export const openCliLoginTerminal = (workspaceId: string, engine: CliEngine, botId: string | null) =>
  api().call('openCliLoginTerminal', { params: { workspaceId, engine }, body: botId ? { botId } : {} })

/** Calls on a provider being edited (not saved yet). */
export const providerDraft = {
  fetchModels: (workspaceId: string, draft: ProviderDraft) =>
    api().call('fetchProviderDraftModels', { params: { workspaceId }, body: { draft } }),
  fetchEmbeddingModels: (workspaceId: string, draft: ProviderDraft) =>
    api().call('fetchProviderDraftEmbeddingModels', { params: { workspaceId }, body: { draft } }),
  fetchImageModels: (workspaceId: string, draft: ProviderDraft) =>
    api().call('fetchProviderDraftImageModels', { params: { workspaceId }, body: { draft } }),
  probeEmbedding: (workspaceId: string, draft: ProviderDraft, model: string) =>
    api().call('probeProviderDraftEmbedding', { params: { workspaceId }, body: { draft, model } }),
  test: (workspaceId: string, draft: ProviderDraft, model?: string) =>
    api().call('testProviderDraft', {
      params: { workspaceId },
      body: { draft, ...(model ? { model } : {}) },
    }),
}
