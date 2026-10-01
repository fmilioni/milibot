import { z } from 'zod'

import { isOpenRouterServer } from './providers'

export const IMAGE_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const
export const ImageAspect = z.enum(IMAGE_ASPECTS)
export type ImageAspect = z.infer<typeof ImageAspect>

export const MAX_IMAGES_PER_CALL = 4

export const ImageModelChoice = z.object({ providerId: z.string(), model: z.string() })
export type ImageModelChoice = z.infer<typeof ImageModelChoice>

/**
 * How an OpenAI-compatible provider draws: OpenRouter's chat completions with image output, Google's native
 * API (Gemini image models and Imagen), or the OpenAI Images API (OpenAI and servers that copy it).
 */
export type ImageProtocol = 'openrouter' | 'google' | 'openai_images'

function isGoogleServer(baseUrl: string | null, preset: string | null): boolean {
  return preset === 'google' || (baseUrl ?? '').includes('generativelanguage.googleapis.com')
}

export function imageProtocol(baseUrl: string | null, preset: string | null): ImageProtocol {
  if (isOpenRouterServer(baseUrl, preset)) return 'openrouter'
  if (isGoogleServer(baseUrl, preset)) return 'google'
  return 'openai_images'
}
