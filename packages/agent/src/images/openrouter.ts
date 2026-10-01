import { toBase64 } from '../llm/http/base64'
import { apiHeaders } from '../llm/http/headers'
import { fromDataUrl, postJson } from './http'
import {
  type ImageBytes,
  ImageGenerationError,
  type ImageRequest,
  type ImageResult,
  type ImageServer,
} from './types'

interface OpenRouterImageResponse {
  choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: unknown } }> } }>
  usage?: { cost?: unknown }
}

export function openRouterHeaders(server: ImageServer): Record<string, string> {
  return apiHeaders({
    apiKey: server.apiKey,
    extraHeaders: server.extraHeaders,
    json: true,
    openRouter: true,
  })
}

async function one(server: ImageServer, request: ImageRequest): Promise<ImageResult> {
  const content = [
    { type: 'text', text: request.prompt },
    ...request.references.map((r) => ({
      type: 'image_url',
      image_url: { url: `data:${r.mediaType};base64,${toBase64(r.bytes)}` },
    })),
  ]
  const json = (await postJson(server, {
    url: `${server.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    headers: openRouterHeaders(server),
    body: JSON.stringify({
      model: request.model,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: request.aspect },
      usage: { include: true },
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  })) as OpenRouterImageResponse
  const images = (json.choices?.[0]?.message?.images ?? []).flatMap((image): ImageBytes[] => {
    const url = image.image_url?.url
    const decoded = typeof url === 'string' ? fromDataUrl(url) : null
    return decoded ? [decoded] : []
  })
  if (images.length === 0) throw new ImageGenerationError('no_image', 'the model answered without a picture')
  const cost = json.usage?.cost
  return {
    images: images.slice(0, 1),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  }
}

export async function generateOpenRouter(server: ImageServer, request: ImageRequest): Promise<ImageResult> {
  const results = await Promise.all(Array.from({ length: request.count }, () => one(server, request)))
  const costs = results.map((r) => r.costUsd)
  return {
    images: results.flatMap((r) => r.images),
    costUsd: costs.every((c) => c !== null) ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0) : null,
  }
}
