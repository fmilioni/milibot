import { createHash } from 'node:crypto'

import { solidPng } from '../media/png'
import type { ImageGenerate } from './generate'

const FAKE_SIDE = 96

/** `MILIBOT_FAKE_IMAGES=1`: solid PNGs shaped like the aspect, colored by the prompt (no provider call). */
export const fakeGenerateImages: ImageGenerate = async (_server, request) => {
  const [w, h] = request.aspect.split(':').map(Number) as [number, number]
  const width = w >= h ? FAKE_SIDE : Math.round((FAKE_SIDE * w) / h)
  const height = h >= w ? FAKE_SIDE : Math.round((FAKE_SIDE * h) / w)
  const images = Array.from({ length: request.count }, (_, i) => {
    const digest = createHash('sha256').update(`${request.prompt}#${i}`).digest()
    return {
      bytes: solidPng(width, height, [digest[0] as number, digest[1] as number, digest[2] as number]),
      mediaType: 'image/png',
    }
  })
  return { images, costUsd: null }
}
