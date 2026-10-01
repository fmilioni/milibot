import { describe, expect, it } from 'vitest'

import { needsLatinExt, parseGoogleCss } from '../../../src/runtime/design/fonts'
import { externalImageSources, prepareFrameHtml, replaceSources } from '../../../src/runtime/design/html'

describe('frame HTML', () => {
  it('strips scripts, handlers, frames and unsafe URLs and turns icons into SVG', () => {
    const prepared = prepareFrameHtml(
      '<div class="flex gap-2" onclick="steal()"><script>alert(1)</script><iframe src="x"></iframe>' +
        '<link rel="stylesheet" href="https://evil"><a href="javascript:alert(1)" class="text-primary">x</a>' +
        '<svg><script>1</script><circle r="1"/></svg><img src="asset:abc" onerror="x()">' +
        '<i data-icon="lucide:arrow-right" class="size-5"></i><i data-icon="lucide:not-an-icon"></i></div>',
    )
    expect(prepared.html).not.toMatch(/script|onclick|onerror|iframe|<link|javascript:/)
    expect(prepared.html).toContain('<a class="text-primary">x</a>')
    expect(prepared.html).toMatch(
      /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*data-icon="lucide:arrow-right" class="size-5"><path/,
    )
    expect(prepared.html).toContain('data-icon-missing="lucide:not-an-icon"')
    expect(prepared.problems).toEqual([expect.objectContaining({ kind: 'unknown_icon' })])
    expect(prepared.candidates.sort()).toEqual(['flex', 'gap-2', 'size-5', 'text-primary'])
  })

  it('finds images to bring in and rewrites their sources', () => {
    const html =
      '<img src="/workspace/logo.png"><div style="background-image: url(\'https://x.io/bg.jpg\')"></div>' +
      '<img src="asset:0000"><img src="data:image/png;base64,AAAA">'
    const css = '.hero { background: url(/workspace/hero.webp) }'
    expect(externalImageSources(html, css)).toEqual([
      '/workspace/logo.png',
      'https://x.io/bg.jpg',
      'data:image/png;base64,AAAA',
      '/workspace/hero.webp',
    ])
    const map = new Map([
      ['/workspace/logo.png', 'asset:1'],
      ['/workspace/hero.webp', 'asset:2'],
    ])
    expect(replaceSources(html, map)).toContain('<img src="asset:1">')
    expect(replaceSources(css, map)).toBe('.hero { background: url(asset:2) }')
  })

  it('knows font subsets by the text', () => {
    expect(needsLatinExt('Café, naïve, façade')).toBe(false)
    expect(needsLatinExt('Łódź')).toBe(true)
  })

  it('reads the latin faces of a Google Fonts stylesheet', () => {
    const css = `/* cyrillic */
@font-face { font-family: 'Fraunces'; src: url(https://f/c.woff2) format('woff2'); unicode-range: U+0400; }
/* latin-ext */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 100 900; src: url(https://f/le.woff2) format('woff2'); unicode-range: U+0100-02BA; }
/* latin */
@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 100 900; src: url(https://f/l.woff2) format('woff2'); unicode-range: U+0000-00FF; }`
    expect(parseGoogleCss(css)).toEqual([
      {
        subset: 'latin-ext',
        url: 'https://f/le.woff2',
        weight: '100 900',
        style: 'normal',
        unicodeRange: 'U+0100-02BA',
      },
      {
        subset: 'latin',
        url: 'https://f/l.woff2',
        weight: '100 900',
        style: 'normal',
        unicodeRange: 'U+0000-00FF',
      },
    ])
  })
})
