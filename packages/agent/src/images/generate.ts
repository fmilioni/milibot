import { imageProtocol } from '@milibot/shared'

import { checkImageRequest } from './catalog'
import { generateGoogle } from './google'
import { generateOpenAiImages } from './openai-images'
import { generateOpenRouter } from './openrouter'
import type { ImageRequest, ImageResult, ImageServer } from './types'

export type ImageGenerate = (server: ImageServer, request: ImageRequest) => Promise<ImageResult>

export const generateImages: ImageGenerate = (server, request) => {
  checkImageRequest(server, { ...request, referenceCount: request.references.length })
  switch (imageProtocol(server.baseUrl, server.preset)) {
    case 'openrouter':
      return generateOpenRouter(server, request)
    case 'google':
      return generateGoogle(server, request)
    case 'openai_images':
      return generateOpenAiImages(server, request)
  }
}
