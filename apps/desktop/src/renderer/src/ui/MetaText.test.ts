import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MetaText } from './MetaText'

describe('MetaText', () => {
  it('replaces the thin middle dot with round separators', () => {
    const html = renderToStaticMarkup(createElement(MetaText, { text: '$2.47 today · 412k tokens' }))
    expect(html).toBe('$2.47 today<span class="meta-dot"><span class="sr-only">, </span></span>412k tokens')
  })
})
