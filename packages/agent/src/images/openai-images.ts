import type { ImageAspect } from '@milibot/shared'

import { apiHeaders } from '../llm/http/headers'
import { postJson } from './http'
import {
  type ImageBytes,
  ImageGenerationError,
  type ImageRequest,
  type ImageResult,
  type ImageServer,
} from './types'

interface ImagesResponse {
  data?: Array<{ b64_json?: unknown; url?: unknown }>
}

function orientation(aspect: ImageAspect): 'square' | 'landscape' | 'portrait' {
  const [w, h] = aspect.split(':').map(Number) as [number, number]
  return w === h ? 'square' : w > h ? 'landscape' : 'portrait'
}

/** The closest size the model accepts (gpt-image: 1536 wide or tall; DALL·E 3: 1792). */
export function openAiImageSize(model: string, aspect: ImageAspect): string {
  const long = /dall-e-3/.test(model) ? 1792 : 1536
  const shape = /dall-e-2/.test(model) ? 'square' : orientation(aspect)
  if (shape === 'landscape') return `${long}x1024`
  if (shape === 'portrait') return `1024x${long}`
  return '1024x1024'
}

function headers(server: ImageServer, json: boolean): Record<string, string> {
  return apiHeaders({ apiKey: server.apiKey, extraHeaders: server.extraHeaders, json })
}

async function download(url: string, server: ImageServer, signal?: AbortSignal): Promise<ImageBytes> {
  const res = await (server.fetch ?? fetch)(url, signal ? { signal } : {})
  if (!res.ok)
    throw new ImageGenerationError('invalid_response', `picture download failed: HTTP ${res.status}`)
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mediaType: res.headers.get('content-type') ?? 'image/png',
  }
}

/**
 * OpenAI Images API: `/images/generations`, or `/images/edits` (multipart) with reference images. gpt-image
 * always answers base64 PNG; DALL·E is asked for base64 and other servers may still answer URLs.
 */
export async function generateOpenAiImages(server: ImageServer, request: ImageRequest): Promise<ImageResult> {
  const base = server.baseUrl.replace(/\/+$/, '')
  const gptImage = /gpt-image/.test(request.model)
  const fields: Record<string, string> = {
    model: request.model,
    prompt: request.prompt,
    n: String(request.count),
    size: openAiImageSize(request.model, request.aspect),
  }
  if (gptImage) {
    fields.output_format = 'png'
    if (request.transparent) fields.background = 'transparent'
  } else if (/dall-e/.test(request.model)) fields.response_format = 'b64_json'

  const common = {
    ...(request.signal ? { signal: request.signal } : {}),
  }
  let json: ImagesResponse
  if (request.references.length > 0) {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    request.references.forEach((r, i) => {
      const ext = r.mediaType === 'image/jpeg' ? 'jpg' : r.mediaType === 'image/webp' ? 'webp' : 'png'
      form.append(
        gptImage ? 'image[]' : 'image',
        new Blob([new Uint8Array(r.bytes)], { type: r.mediaType }),
        `reference-${i + 1}.${ext}`,
      )
    })
    json = (await postJson(server, {
      url: `${base}/images/edits`,
      headers: headers(server, false),
      body: form,
      ...common,
    })) as ImagesResponse
  } else {
    const body = { ...fields, n: request.count }
    json = (await postJson(server, {
      url: `${base}/images/generations`,
      headers: headers(server, true),
      body: JSON.stringify(body),
      ...common,
    })) as ImagesResponse
  }
  const images: ImageBytes[] = []
  for (const item of json.data ?? []) {
    if (typeof item.b64_json === 'string')
      images.push({ bytes: new Uint8Array(Buffer.from(item.b64_json, 'base64')), mediaType: 'image/png' })
    else if (typeof item.url === 'string') images.push(await download(item.url, server, request.signal))
  }
  if (images.length === 0) throw new ImageGenerationError('no_image', 'the server answered without a picture')
  return { images, costUsd: null }
}
