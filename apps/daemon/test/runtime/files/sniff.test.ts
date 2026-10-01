import { describe, expect, it } from 'vitest'

import { imageMediaType, isThumbnailable, mimeFromName } from '../../../src/runtime/files/sniff'

describe('file sniffing', () => {
  it('recognizes SVG markup only when asked', () => {
    const svg = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg viewBox="0 0 1 1"></svg>')
    expect(imageMediaType(svg)).toBeNull()
    expect(imageMediaType(svg, { svg: true })).toBe('image/svg+xml')
    expect(imageMediaType(Buffer.from('  <svg>'), { svg: true })).toBe('image/svg+xml')
    expect(imageMediaType(Buffer.from('<svgx>'), { svg: true })).toBeNull()
    expect(imageMediaType(Buffer.from('89504e470d0a1a0a', 'hex'), { svg: true })).toBe('image/png')
  })

  it('makes thumbnails of PNG and JPEG only', () => {
    expect(isThumbnailable('image/png')).toBe(true)
    expect(isThumbnailable('image/jpeg')).toBe(true)
    expect(isThumbnailable('image/gif')).toBe(false)
    expect(isThumbnailable(null)).toBe(false)
  })

  it('guesses a media type from the extension', () => {
    expect(mimeFromName('Report.PDF')).toBe('application/pdf')
    expect(mimeFromName('photo.jpeg')).toBe('image/jpeg')
    expect(mimeFromName('archive.tar.gz')).toBe('application/octet-stream')
    expect(mimeFromName('.png')).toBe('application/octet-stream')
    expect(mimeFromName('README')).toBe('application/octet-stream')
  })
})
