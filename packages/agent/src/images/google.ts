import type { ImageAspect } from '@milibot/shared'

import { toBase64 } from '../llm/http/base64'
import { isImagenModel } from './catalog'
import { postJson } from './http'
import {
  type ImageBytes,
  ImageGenerationError,
  type ImageRequest,
  type ImageResult,
  type ImageServer,
} from './types'

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: unknown; data?: unknown } }> } }>
  promptFeedback?: { blockReason?: unknown }
}

interface PredictResponse {
  predictions?: Array<{ bytesBase64Encoded?: unknown; mimeType?: unknown }>
}

/** Native API root of the OpenAI-compatible endpoint (`…/v1beta/openai` → `…/v1beta`). */
export function googleNativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/openai$/, '')
}

export function googleHeaders(server: ImageServer): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...server.extraHeaders }
  if (server.apiKey) headers['x-goog-api-key'] = server.apiKey
  return headers
}

const modelPath = (model: string) => (model.startsWith('models/') ? model : `models/${model}`)

/** Imagen takes five shapes: 3:2 and 2:3 go to the nearest one. */
function imagenAspect(aspect: ImageAspect): string {
  if (aspect === '3:2') return '4:3'
  if (aspect === '2:3') return '3:4'
  return aspect
}

async function gemini(server: ImageServer, request: ImageRequest): Promise<ImageBytes> {
  const parts = [
    { text: request.prompt },
    ...request.references.map((r) => ({ inlineData: { mimeType: r.mediaType, data: toBase64(r.bytes) } })),
  ]
  const json = (await postJson(server, {
    url: `${googleNativeBase(server.baseUrl)}/${modelPath(request.model)}:generateContent`,
    headers: googleHeaders(server),
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: request.aspect },
      },
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  })) as GenerateContentResponse
  for (const part of json.candidates?.[0]?.content?.parts ?? []) {
    const data = part.inlineData?.data
    if (typeof data === 'string')
      return {
        bytes: new Uint8Array(Buffer.from(data, 'base64')),
        mediaType: typeof part.inlineData?.mimeType === 'string' ? part.inlineData.mimeType : 'image/png',
      }
  }
  const blocked = json.promptFeedback?.blockReason
  throw new ImageGenerationError(
    'no_image',
    typeof blocked === 'string'
      ? `the prompt was blocked (${blocked})`
      : 'the model answered without a picture',
  )
}

async function imagen(server: ImageServer, request: ImageRequest): Promise<ImageBytes[]> {
  const json = (await postJson(server, {
    url: `${googleNativeBase(server.baseUrl)}/${modelPath(request.model)}:predict`,
    headers: googleHeaders(server),
    body: JSON.stringify({
      instances: [{ prompt: request.prompt }],
      parameters: { sampleCount: request.count, aspectRatio: imagenAspect(request.aspect) },
    }),
    ...(request.signal ? { signal: request.signal } : {}),
  })) as PredictResponse
  const images = (json.predictions ?? []).flatMap((p): ImageBytes[] =>
    typeof p.bytesBase64Encoded === 'string'
      ? [
          {
            bytes: new Uint8Array(Buffer.from(p.bytesBase64Encoded, 'base64')),
            mediaType: typeof p.mimeType === 'string' ? p.mimeType : 'image/png',
          },
        ]
      : [],
  )
  if (images.length === 0) throw new ImageGenerationError('no_image', 'the model answered without a picture')
  return images
}

export async function generateGoogle(server: ImageServer, request: ImageRequest): Promise<ImageResult> {
  if (isImagenModel(request.model)) return { images: await imagen(server, request), costUsd: null }
  const images = await Promise.all(Array.from({ length: request.count }, () => gemini(server, request)))
  return { images, costUsd: null }
}
