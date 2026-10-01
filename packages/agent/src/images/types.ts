import type { ImageAspect } from '@milibot/shared'

export interface ImageServer {
  baseUrl: string
  apiKey: string | null
  preset: string | null
  extraHeaders?: Record<string, string>
  fetch?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface ImageBytes {
  bytes: Uint8Array
  mediaType: string
}

export interface ImageRequest {
  model: string
  prompt: string
  count: number
  aspect: ImageAspect
  transparent: boolean
  references: ImageBytes[]
  signal?: AbortSignal
}

export interface ImageResult {
  images: ImageBytes[]
  /** What the provider charged, when it says (OpenRouter `usage.cost`). */
  costUsd: number | null
}

export type ImageErrorCode =
  /** The model can't do what was asked (transparency, references): pick another. */
  | 'unsupported'
  /** No quota or credit for the model (free tier without it, billing off, out of credit): waiting won't help. */
  | 'quota'
  /** Still rate limited after the retries. */
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_response'
  /** The provider answered without a picture (refused the prompt, or answered in text). */
  | 'no_image'
  | 'aborted'

export class ImageGenerationError extends Error {
  constructor(
    readonly code: ImageErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'ImageGenerationError'
  }
}

export interface ImageModelListing {
  modelId: string
  displayName: string
  description: string | null
  pricePerImageUsd: number | null
  supportsVision: boolean
  /** The server says it draws (OpenRouter, Google), or the id looks like it (other servers). */
  image: boolean
}

export interface ImageModelList {
  models: ImageModelListing[]
  verified: boolean
}
