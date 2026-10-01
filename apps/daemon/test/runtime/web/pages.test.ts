import { describe, expect, it } from 'vitest'

import {
  formatDocPage,
  outline,
  selectRelevant,
  splitPages,
  type WebDoc,
} from '../../../src/runtime/web/pages'

const HOST_CUT = 12_000

describe('pages', () => {
  const long = [
    '# Guide',
    ...Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${'Words about the topic. '.repeat(60)}`),
    '```js\n' + Array.from({ length: 900 }, (_, i) => `console.log(${i})`).join('\n') + '\n```',
    'x'.repeat(30_000),
  ].join('\n\n')

  it('splits into parts that stay under the host cut with their header, fences balanced', () => {
    const pages = splitPages(long)
    expect(pages.length).toBeGreaterThan(5)
    const doc = webDoc(long)
    for (let n = 1; n <= pages.length; n++) {
      const part = formatDocPage(doc, n)
      expect(part.length).toBeLessThan(HOST_CUT)
      expect((pages[n - 1]!.match(/^```/gm) ?? []).length % 2).toBe(0)
    }
    expect(formatDocPage(doc, 2)).toContain(`Part 2 of ${pages.length}`)
    expect(formatDocPage(doc, 999)).toContain('this is the last one')
  })

  it('tells a bot check apart from a page that needs JavaScript', () => {
    const blocked = webDoc('', { status: 403, title: 'Just a moment...', needsJs: true })
    expect(formatDocPage(blocked, 1)).toContain('refused automated access (HTTP 403')
    expect(formatDocPage(blocked, 1)).not.toContain('needs JavaScript')
    expect(formatDocPage(webDoc('', { needsJs: true }), 1)).toContain('needs JavaScript')
  })

  it('outlines headings with their part, clipped', () => {
    const text = outline(splitPages(long))
    expect(text).toMatch(/^Guide \(1\) · Section 0 \(1\)/)
    expect(text.length).toBeLessThanOrEqual(402)
  })

  it('cuts a long page for the helper model to the parts about the request, in order', () => {
    const text = [
      'Intro of the product.',
      ...Array.from({ length: 80 }, (_, i) =>
        i === 60 ? 'Pricing: the Pro plan costs $10.' : 'Filler. '.repeat(250),
      ),
    ].join('\n\n')
    const picked = selectRelevant(text, 'What does the Pro plan cost?', 10_000)
    expect(picked.partial).toBe(true)
    expect(picked.text.length).toBeLessThanOrEqual(10_000)
    expect(picked.text.startsWith('Intro of the product.')).toBe(true)
    expect(picked.text).toContain('Pro plan costs $10')
    expect(selectRelevant('short', 'x', 100)).toEqual({ text: 'short', partial: false })
  })
})

function webDoc(markdown: string, overrides: Partial<WebDoc> = {}): WebDoc {
  const pages = splitPages(markdown)
  return {
    requestedUrl: 'https://tool.dev/a',
    url: 'https://tool.dev/a',
    redirects: [],
    status: 200,
    title: 'Doc',
    published: null,
    kind: 'html',
    markdown,
    pages,
    outline: outline(pages),
    truncated: false,
    needsJs: false,
    fetchedAt: 0,
    ...overrides,
  }
}
