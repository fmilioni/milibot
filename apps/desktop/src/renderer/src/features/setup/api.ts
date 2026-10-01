import type { CliEngine } from '@milibot/shared'

import { api } from '@/api/daemon'
import {
  addCliProvider,
  createProvider,
  deleteProvider,
  getCliLoginStatus,
  openCliLoginTerminal,
  updateProvider,
} from '@/features/providers/api'

import { pickDefaultModel } from './lib/setup'
import type { ProviderSavePlan } from './lib/setup-flow'

/** Runs step 1's save (`planProviderSave`) one call at a time, then marks the default provider. */
export async function saveProviders(workspaceId: string, plan: ProviderSavePlan): Promise<void> {
  const ids = { ...plan.ids }
  for (const op of plan.ops) {
    if (op.op === 'remove') await deleteProvider(workspaceId, op.providerId)
    else if (op.op === 'createCli') ids[op.engine] = (await addCliProvider(workspaceId, op.engine)).id
    else {
      const { existing, apiKey } = op
      const provider = existing
        ? apiKey
          ? await updateProvider(workspaceId, existing.id, { apiKey })
          : existing
        : await createProvider(workspaceId, {
            type: 'openai_compatible',
            name: 'OpenRouter',
            preset: 'openrouter',
            apiKey: apiKey ?? '',
          })
      ids.openrouter = provider.id
      if (!provider.defaultModel) {
        try {
          const models = await api().call('fetchProviderModels', {
            params: { workspaceId, providerId: provider.id },
          })
          const model = pickDefaultModel(models)
          if (model) await updateProvider(workspaceId, provider.id, { defaultModel: model })
        } catch {
          // Without the list the bots use the first model enabled later in the settings.
        }
      }
      if (!existing)
        void api()
          .call('addSuggestedEmbeddingModels', { params: { workspaceId, providerId: provider.id } })
          .catch(() => undefined)
    }
  }
  const defaultId = plan.defaultRow ? ids[plan.defaultRow] : undefined
  if (defaultId) await updateProvider(workspaceId, defaultId, { isDefault: true })
}

export const checkOpenRouterKey = (workspaceId: string, apiKey: string) =>
  api().call('checkOpenRouterKey', { params: { workspaceId }, body: { apiKey } })

export const cliLoginStatus = (engine: CliEngine, workspaceId: string) =>
  getCliLoginStatus(workspaceId, engine)

/** The bot's screen is reachable (fails while the VM is still coming up). */
export async function waitForBotScreen(workspaceId: string, botId: string): Promise<void> {
  await api().call('getBotDisplay', { params: { workspaceId, botId } })
}

export const openLoginTerminal = (engine: CliEngine, workspaceId: string, botId: string) =>
  openCliLoginTerminal(workspaceId, engine, botId)

/** Signs the engine in with an API key instead of the subscription. */
export const signInWithApiKey = (workspaceId: string, providerId: string, apiKey: string) =>
  updateProvider(workspaceId, providerId, { authMode: 'api_key', apiKey })
