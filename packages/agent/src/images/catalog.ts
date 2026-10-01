import { type ImageProtocol, imageProtocol } from '@milibot/shared'

import { ImageGenerationError, type ImageRequest } from './types'

interface KnownImageModel {
  id: RegExp
  /** Standard-quality square picture, as the provider listed it; the user can edit the registered price. */
  pricePerImageUsd: number
  references: boolean
}

const KNOWN: KnownImageModel[] = [
  { id: /gemini-[\d.]+-flash-image/, pricePerImageUsd: 0.039, references: true },
  { id: /gemini-.*-pro-image/, pricePerImageUsd: 0.134, references: true },
  { id: /imagen-[\d.]+-ultra/, pricePerImageUsd: 0.06, references: false },
  { id: /imagen-[\d.]+-fast/, pricePerImageUsd: 0.02, references: false },
  { id: /imagen-/, pricePerImageUsd: 0.04, references: false },
  { id: /gpt-image-[\d.]+-mini/, pricePerImageUsd: 0.011, references: true },
  { id: /gpt-image/, pricePerImageUsd: 0.042, references: true },
  { id: /dall-e-3/, pricePerImageUsd: 0.04, references: false },
  { id: /dall-e-2/, pricePerImageUsd: 0.02, references: true },
]

export function findKnownImageModel(model: string): KnownImageModel | null {
  return KNOWN.find((m) => m.id.test(model)) ?? null
}

export function isImagenModel(model: string): boolean {
  return /(^|\/)imagen-/.test(model)
}

function supportsTransparency(protocol: ImageProtocol, model: string): boolean {
  return protocol === 'openai_images' && /gpt-image/.test(model)
}

function supportsReferences(protocol: ImageProtocol, model: string): boolean {
  if (protocol === 'openrouter') return true
  if (protocol === 'google') return !isImagenModel(model)
  return !/dall-e-3/.test(model)
}

export function checkImageRequest(
  server: { baseUrl: string; preset: string | null },
  request: Pick<ImageRequest, 'model' | 'transparent'> & { referenceCount: number },
): void {
  const protocol = imageProtocol(server.baseUrl, server.preset)
  if (request.transparent && !supportsTransparency(protocol, request.model))
    throw new ImageGenerationError(
      'unsupported',
      `${request.model} can't draw on a transparent background (OpenAI's gpt-image models can); leave transparent off or pick another model`,
    )
  if (request.referenceCount > 0 && !supportsReferences(protocol, request.model))
    throw new ImageGenerationError(
      'unsupported',
      `${request.model} doesn't take reference images; drop references or pick another model`,
    )
}
