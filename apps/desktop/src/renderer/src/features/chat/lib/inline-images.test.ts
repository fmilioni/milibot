import type { MessageAttachment } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { imageSourcePath, splitInlineImages } from './inline-images'

const image = { sha256: 'a'.repeat(64), mediaType: 'image/png' as const, width: 10, height: 10 }
const attachment = (id: string, path: string, withImage = true): MessageAttachment => ({
  id,
  name: path.split('/').pop() ?? '',
  size: 1,
  mimeType: 'image/png',
  path,
  status: 'ready',
  image: withImage ? image : null,
})

describe('inline images', () => {
  it('decodes the path the renderer gets for an image', () => {
    expect(imageSourcePath('/workspace/caf%C3%A9/front%20and%20back.png')).toBe(
      '/workspace/café/front and back.png',
    )
    expect(imageSourcePath('file:///workspace/a.png')).toBe('/workspace/a.png')
    expect(imageSourcePath('/workspace/100%.png')).toBe('/workspace/100%.png')
  })

  it('places the images the markdown shows inline and keeps the others below', () => {
    const front = attachment('att_1', '/workspace/café/front.png')
    const spaced = attachment('att_2', '/workspace/café/back final.png')
    const other = attachment('att_3', '/workspace/report.png')
    const text = 'Done:\n\n![Front](/workspace/café/front.png)\n\n![Back](</workspace/café/back final.png>)'
    expect(splitInlineImages(text, [front, spaced, other])).toEqual({
      inline: [front, spaced],
      rest: [other],
    })
  })

  it('keeps files without a preview below even when the markdown points at them', () => {
    const file = attachment('att_1', '/workspace/a.png', false)
    expect(splitInlineImages('![a](/workspace/a.png)', [file])).toEqual({ inline: [], rest: [file] })
  })
})
