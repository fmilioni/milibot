import type { Provider, ProviderModel, UpdateProviderBody } from '@milibot/shared'

import { api } from '@/api/daemon'
import {
  chatModelBody,
  diffEmbeddingModels,
  diffImageModels,
  diffModels,
  embeddingModelBody,
  type EmbeddingRow,
  imageModelBody,
  type ImageRow,
  type ModelRow,
  presetForUrl,
} from '@/features/providers/lib/provider-form'

export interface ProviderFormSave {
  /** The provider being edited; absent for a new one. */
  provider: Provider | undefined
  type: 'openai_compatible' | 'anthropic'
  fields: Required<Pick<UpdateProviderBody, 'name' | 'baseUrl' | 'extraHeaders'>> &
    Pick<
      UpdateProviderBody,
      'apiKey' | 'reasoningParam' | 'outputCapField' | 'reasoningReplay' | 'lightModel'
    >
  savedModels: ProviderModel[]
  rows: ModelRow[]
  savedEmbeddingModels: ProviderModel[]
  embeddingRows: EmbeddingRow[]
  savedImageModels: ProviderModel[]
  imageRows: ImageRow[]
}

/** Creates or updates the provider, then applies the model table changes one call at a time. */
export async function saveProviderForm(workspaceId: string, form: ProviderFormSave): Promise<void> {
  const { provider, type, fields } = form
  const saved = provider
    ? await api().call('updateProvider', { params: { workspaceId, providerId: provider.id }, body: fields })
    : await api().call('createProvider', {
        params: { workspaceId },
        body: {
          ...fields,
          type,
          preset: presetForUrl(fields.baseUrl ?? ''),
        },
      })
  const providerId = saved.id
  const changes = diffModels(form.savedModels, form.rows)
  const embeddingChanges =
    type === 'openai_compatible'
      ? diffEmbeddingModels(form.savedEmbeddingModels, form.embeddingRows)
      : { create: [], update: [], remove: [] }
  const imageChanges =
    type === 'openai_compatible'
      ? diffImageModels(form.savedImageModels, form.imageRows)
      : { create: [], update: [], remove: [] }
  for (const body of [
    ...changes.create.map(chatModelBody),
    ...embeddingChanges.create.map(embeddingModelBody),
    ...imageChanges.create.map(imageModelBody),
  ])
    await api().call('createProviderModel', { params: { workspaceId, providerId }, body })
  for (const [id, body] of [
    ...changes.update.map((r) => [r.id as string, chatModelBody(r)] as const),
    ...embeddingChanges.update.map((r) => [r.id as string, embeddingModelBody(r)] as const),
    ...imageChanges.update.map((r) => [r.id as string, imageModelBody(r)] as const),
  ])
    await api().call('updateProviderModel', { params: { workspaceId, providerId, modelId: id }, body })
  for (const id of [...changes.remove, ...embeddingChanges.remove, ...imageChanges.remove])
    await api().call('deleteProviderModel', { params: { workspaceId, providerId, modelId: id } })
}
