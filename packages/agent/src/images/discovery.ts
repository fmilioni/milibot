import { imageProtocol } from '@milibot/shared'

import { apiHeaders } from '../llm/http/headers'
import { shortDescription } from '../llm/http/listing'
import { findKnownImageModel, isImagenModel } from './catalog'
import { googleHeaders, googleNativeBase } from './google'
import { openRouterHeaders } from './openrouter'
import { ImageGenerationError, type ImageModelList, type ImageModelListing, type ImageServer } from './types'

interface ListedModel {
  id?: unknown
  name?: unknown
  description?: unknown
  architecture?: { input_modalities?: unknown; output_modalities?: unknown }
}

interface GoogleModel {
  name?: unknown
  displayName?: unknown
  description?: unknown
  supportedGenerationMethods?: unknown
}

const LIST_TIMEOUT_MS = 10_000
/** Families of image models, for servers whose `/models` doesn't say what a model does. */
const IMAGE_ID = /gpt-image|dall-e|flux|imagen|stable-diffusion|sdxl|sd3|image/i

const text = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback)

export function parseOpenRouterImageModels(json: unknown): ImageModelListing[] {
  const data = (json as { data?: ListedModel[] } | null)?.data
  if (!Array.isArray(data)) return []
  return data.flatMap((m): ImageModelListing[] => {
    if (typeof m.id !== 'string' || !m.id) return []
    const outputs = m.architecture?.output_modalities
    if (Array.isArray(outputs) && !outputs.includes('image')) return []
    const inputs = m.architecture?.input_modalities
    return [
      {
        modelId: m.id,
        displayName: text(m.name, m.id),
        description: shortDescription(m.description),
        pricePerImageUsd: findKnownImageModel(m.id)?.pricePerImageUsd ?? null,
        supportsVision: Array.isArray(inputs) && inputs.includes('image'),
        image: true,
      },
    ]
  })
}

export function parseGoogleImageModels(json: unknown): ImageModelListing[] {
  const models = (json as { models?: GoogleModel[] } | null)?.models
  if (!Array.isArray(models)) return []
  return models.flatMap((m): ImageModelListing[] => {
    if (typeof m.name !== 'string') return []
    const id = m.name.replace(/^models\//, '')
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : []
    const imagen = isImagenModel(id) && methods.includes('predict')
    const gemini = /^gemini-.*image/.test(id) && methods.includes('generateContent')
    if (!imagen && !gemini) return []
    return [
      {
        modelId: id,
        displayName: text(m.displayName, id),
        description: shortDescription(m.description),
        pricePerImageUsd: findKnownImageModel(id)?.pricePerImageUsd ?? null,
        supportsVision: gemini,
        image: true,
      },
    ]
  })
}

export function parseGenericImageModels(json: unknown): ImageModelListing[] {
  const data = (json as { data?: ListedModel[] } | null)?.data
  if (!Array.isArray(data)) return []
  return data
    .flatMap((m): ImageModelListing[] => {
      if (typeof m.id !== 'string' || !m.id) return []
      const known = findKnownImageModel(m.id)
      return [
        {
          modelId: m.id,
          displayName: text(m.name, m.id),
          description: shortDescription(m.description),
          pricePerImageUsd: known?.pricePerImageUsd ?? null,
          supportsVision: known?.references ?? false,
          image: IMAGE_ID.test(m.id),
        },
      ]
    })
    .sort((a, b) => Number(b.image) - Number(a.image) || a.modelId.localeCompare(b.modelId))
}

async function getJson(url: string, headers: Record<string, string>, server: ImageServer): Promise<unknown> {
  const res = await (server.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ImageGenerationError('provider_error', `HTTP ${res.status}: ${body.slice(0, 300)}`, res.status)
  }
  return res.json().catch(() => null)
}

export async function listImageModels(server: ImageServer): Promise<ImageModelList> {
  const base = server.baseUrl.replace(/\/+$/, '')
  switch (imageProtocol(base, server.preset)) {
    case 'openrouter':
      return {
        models: parseOpenRouterImageModels(
          await getJson(`${base}/models?output_modalities=image`, openRouterHeaders(server), server),
        ),
        verified: true,
      }
    case 'google':
      return {
        models: parseGoogleImageModels(
          await getJson(`${googleNativeBase(base)}/models?pageSize=1000`, googleHeaders(server), server),
        ),
        verified: true,
      }
    case 'openai_images': {
      const headers = apiHeaders({ apiKey: server.apiKey, extraHeaders: server.extraHeaders })
      return {
        models: parseGenericImageModels(await getJson(`${base}/models`, headers, server)),
        verified: false,
      }
    }
  }
}
