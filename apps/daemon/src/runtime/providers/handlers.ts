import { listEmbeddingModels, probeEmbeddingModel } from '@milibot/agent/embeddings'
import { listImageModels } from '@milibot/agent/images'
import { AnthropicProvider, type LLMProvider, OpenAICompatibleProvider } from '@milibot/agent/llm'
import {
  type EndpointResponse,
  isOpenRouterServer,
  OPENROUTER_BASE_URL,
  type Provider,
  type ProviderDraft,
  type providerEndpoints,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { VmController } from '../vm'
import { cliEngineHost } from './cli-engines'
import type { CliEngineHost } from './cli-engines/host'
import type { ProviderClients } from './clients'
import { presetBaseUrl } from './presets'
import type { ProviderStore } from './store'

type TestResult = EndpointResponse<'testProvider'>

function failedTest(model: string | null, error: string): TestResult {
  return { ok: false, model, supportsTools: false, supportsVision: false, latencyMs: null, error }
}

/** Connection of the form's provider: unsaved fields win over the stored ones. */
async function draftConnection(providers: ProviderStore, draft: ProviderDraft) {
  const apiKey = draft.apiKey
    ? draft.apiKey
    : draft.providerId
      ? await providers.secret(draft.providerId)
      : null
  const baseUrl = draft.baseUrl ?? presetBaseUrl(draft.preset ?? null)
  return { apiKey, baseUrl }
}

function requireBaseUrl(baseUrl: string | null): string {
  if (!baseUrl) throw new DaemonError('validation_failed', 'An OpenAI-compatible provider needs a base URL')
  return baseUrl
}

async function draftClient(providers: ProviderStore, draft: ProviderDraft): Promise<LLMProvider> {
  const { apiKey, baseUrl } = await draftConnection(providers, draft)
  if (draft.type === 'anthropic')
    return new AnthropicProvider({ id: 'draft', apiKey, baseUrl: draft.baseUrl ?? null, prices: () => null })
  return new OpenAICompatibleProvider({
    id: 'draft',
    baseUrl: requireBaseUrl(baseUrl),
    apiKey,
    preset: draft.preset ?? null,
    extraHeaders: draft.extraHeaders ?? {},
    prices: () => null,
  })
}

/** The OpenAI-compatible API of the form's provider (embedding and image models). */
async function draftServer(providers: ProviderStore, draft: ProviderDraft) {
  if (draft.type !== 'openai_compatible')
    throw new DaemonError(
      'validation_failed',
      'Only OpenAI-compatible providers have embedding and image models',
    )
  const { apiKey, baseUrl } = await draftConnection(providers, draft)
  return {
    baseUrl: requireBaseUrl(baseUrl),
    apiKey,
    preset: draft.preset ?? null,
    extraHeaders: draft.extraHeaders ?? {},
  }
}

/** An error of a provider's API as a validation error of the request (shown in the form). */
function asValidation(err: unknown): DaemonError {
  return err instanceof DaemonError ? err : new DaemonError('validation_failed', errorMessage(err))
}

export interface ProviderRoutesDeps {
  providers: ProviderStore
  clients: Pick<ProviderClients, 'client'>
  vm: Pick<VmController, 'guest'>
  now: () => number
  fetch?: typeof fetch
  created: () => void
  updated: (providerId: string) => void
}

/** Providers and models of the settings screen, saved or still in the form (drafts). */
export class ProviderRoutes {
  constructor(private readonly deps: ProviderRoutesDeps) {}

  handlers(): EndpointHandlers<keyof typeof providerEndpoints> {
    const { deps } = this
    const { providers, clients, vm, now } = deps
    const doFetch = deps.fetch ?? fetch

    /** A CLI engine's provider: the CLI answers in the VM and, with the subscription, is logged in. */
    const testCli = async (host: CliEngineHost, provider: Provider): Promise<TestResult> => {
      const started = now()
      try {
        const { ok, error } = await host.test(await vm.guest(), provider)
        return {
          ok,
          model: provider.defaultModel,
          supportsTools: true,
          supportsVision: true,
          latencyMs: now() - started,
          error,
        }
      } catch (err) {
        return failedTest(null, errorMessage(err))
      }
    }

    return {
      listProviders: () => providers.list(),
      createProvider: async ({ body }) => {
        const provider = await providers.create(body)
        deps.created()
        return provider
      },
      updateProvider: async ({ params, body }) => {
        const provider = await providers.update(params.providerId, body)
        deps.updated(provider.id)
        return provider
      },
      deleteProvider: async ({ params }) => {
        await providers.delete(params.providerId)
        return { ok: true as const }
      },
      testProvider: async ({ params, body }) => {
        const provider = await providers.get(params.providerId)
        const host = cliEngineHost(provider.type)
        if (host) return testCli(host, provider)
        const started = now()
        const model =
          body.model ??
          provider.defaultModel ??
          providers.listModels(provider.id).find((m) => m.enabled)?.modelId
        if (!model) return failedTest(null, 'No model to test')
        const result = await (await clients.client(provider.id)).testConnection(model)
        return { ...result, model, latencyMs: now() - started }
      },
      fetchProviderModels: async ({ params }) => {
        const provider = await providers.get(params.providerId)
        const models =
          cliEngineHost(provider.type)?.catalogModels() ??
          (await (await clients.client(provider.id)).listModels())
        return providers.upsertDiscovered(provider.id, models)
      },
      listProviderModels: ({ params, query }) => providers.listModels(params.providerId, query.kind),
      createProviderModel: ({ params, body }) => providers.createModel(params.providerId, body),
      updateProviderModel: ({ params, body }) =>
        providers.updateModel(params.providerId, params.modelId, body),
      deleteProviderModel: ({ params }) => {
        providers.deleteModel(params.providerId, params.modelId)
        return { ok: true as const }
      },

      testProviderDraft: async ({ body }) => {
        const started = now()
        const model = body.model
        if (!model) return failedTest(null, 'No model to test')
        try {
          const result = await (await draftClient(providers, body.draft)).testConnection(model)
          return { ...result, model, latencyMs: now() - started }
        } catch (err) {
          return failedTest(model, errorMessage(err))
        }
      },
      fetchProviderDraftModels: async ({ body }) => {
        try {
          return (await (await draftClient(providers, body.draft)).listModels()).map((m) => ({
            modelId: m.modelId,
            displayName: m.displayName,
            supportsTools: m.supportsTools,
            supportsVision: m.supportsVision,
            contextWindow: m.contextWindow,
            maxOutputTokens: m.maxOutputTokens,
            efforts: m.efforts,
            defaultEffort: m.defaultEffort,
            priceInputPerMtokUsd: m.priceInputPerMtokUsd,
            priceOutputPerMtokUsd: m.priceOutputPerMtokUsd,
            priceCacheWritePerMtokUsd: m.priceCacheWritePerMtokUsd,
            priceCacheReadPerMtokUsd: m.priceCacheReadPerMtokUsd,
          }))
        } catch (err) {
          throw asValidation(err)
        }
      },
      fetchProviderDraftEmbeddingModels: async ({ body }) => {
        try {
          return await listEmbeddingModels({ ...(await draftServer(providers, body.draft)), fetch: doFetch })
        } catch (err) {
          throw asValidation(err)
        }
      },
      probeProviderDraftEmbedding: async ({ body }) =>
        probeEmbeddingModel({
          ...(await draftServer(providers, body.draft)),
          model: body.model,
          fetch: doFetch,
        }),
      fetchProviderDraftImageModels: async ({ body }) => {
        try {
          return await listImageModels({ ...(await draftServer(providers, body.draft)), fetch: doFetch })
        } catch (err) {
          throw asValidation(err)
        }
      },
      addSuggestedEmbeddingModels: async ({ params }) => {
        const server = await providers.server(params.providerId)
        if (!isOpenRouterServer(server.baseUrl, server.preset))
          return providers.listModels(params.providerId, 'embedding')
        const listed = await listEmbeddingModels({ ...server, fetch: doFetch }).catch((err: unknown) => {
          throw asValidation(err)
        })
        return providers.addEmbeddingModels(
          params.providerId,
          listed.models
            .filter((m) => m.suggested)
            .map((m) => ({
              kind: 'embedding' as const,
              modelId: m.modelId,
              displayName: m.displayName,
              contextWindow: m.contextWindow,
              priceInputPerMtokUsd: m.priceInputPerMtokUsd,
              supportsTools: false,
              supportsVision: false,
            })),
        )
      },
      getProviderAccount: async ({ params }) => {
        const provider = await providers.get(params.providerId)
        const none = { creditUsd: null, usageUsd: null, limitUsd: null, error: null }
        if (
          provider.type !== 'openai_compatible' ||
          !isOpenRouterServer(provider.baseUrl ?? '', provider.preset)
        )
          return { supported: false, ...none }
        const key = await providers.secret(provider.id)
        if (!key) return { supported: true, ...none, error: 'no_key' }
        return openRouterAccount(doFetch, key)
      },
    }
  }
}

/** OpenRouter credit: `/credits` (total bought − used), falling back to the key's own limit. */
export async function openRouterAccount(
  doFetch: typeof fetch,
  key: string,
): Promise<{
  supported: boolean
  creditUsd: number | null
  usageUsd: number | null
  limitUsd: number | null
  error: string | null
}> {
  const headers = { authorization: `Bearer ${key}` }
  const getJson = async (path: string) => {
    const res = await doFetch(`${OPENROUTER_BASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return ((await res.json()) as { data?: Record<string, unknown> }).data ?? {}
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  try {
    const credits = await getJson('/credits')
    const total = num(credits.total_credits)
    const used = num(credits.total_usage)
    if (total !== null && used !== null)
      return { supported: true, creditUsd: total - used, usageUsd: used, limitUsd: null, error: null }
  } catch {
    // Keys without access to /credits still describe their own limit.
  }
  try {
    const keyInfo = await getJson('/key')
    return {
      supported: true,
      creditUsd: num(keyInfo.limit_remaining),
      usageUsd: num(keyInfo.usage),
      limitUsd: num(keyInfo.limit),
      error: null,
    }
  } catch (err) {
    return { supported: true, creditUsd: null, usageUsd: null, limitUsd: null, error: errorMessage(err) }
  }
}
