import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Markdown } from './Markdown'
import { RefLinkContext, type RefLinkRenderers } from './RefLinks'

const bots = [
  { id: 'b1', name: 'Analyst' },
  { id: 'b2', name: 'Iris' },
  { id: 'b3', name: 'Chief of Staff' },
  { id: 'b4', name: 'Chief' },
]

describe('Markdown', () => {
  const render = (text: string) =>
    renderToStaticMarkup(
      createElement(Markdown, { text, mentions: bots, copyLabel: 'Copy', copiedLabel: 'Copied' }),
    )

  it('renders inline code as a chip and fenced code as a block', () => {
    const html = render('Run `pnpm test` now.\n\n```ts\nconst a = 1\n```')
    expect(html).toContain('<code class="rounded-[5px] bg-surface-3')
    expect(html).toContain('pnpm test')
    expect(html).toContain('<pre')
    expect(html).toContain('const a = 1')
    expect(html).toContain('>ts<')
  })

  it('turns mentions into chips outside code only', () => {
    const html = render('Hi @Iris, see `@Iris` and **@Analyst**')
    expect(html.match(/data-mention/g)).toHaveLength(2)
  })

  it('shows workspace paths as file chips', () => {
    expect(render('File at `/workspace/report.xlsx`')).toContain('/workspace/report.xlsx')
  })

  it('never renders raw HTML', () => {
    const html = render('<img src=x onerror=alert(1)> <script>alert(1)</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })

  it('leaves out markdown images it cannot load', () => {
    const html = render('Result:\n\n![Front](/workspace/card/front.png) ![Logo](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('Result:')
  })

  it('hands other images to renderImage, outside a paragraph', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        text: '![Front](/workspace/café/front.png)',
        renderImage: (src, alt) => createElement('figure', null, `${alt}@${src}`),
      }),
    )
    expect(html).toContain('<figure>Front@/workspace/caf%C3%A9/front.png</figure>')
    expect(html).not.toContain('<p')
  })

  it('supports GFM tables and lists', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two')
    expect(html).toContain('<table')
    expect(html).toContain('<ul')
  })
})

describe('Markdown reveal decorations', () => {
  const render = (text: string, chunks: { start: number; born: number }[], caret = true) =>
    renderToStaticMarkup(
      createElement(Markdown, {
        text,
        copyLabel: 'Copy',
        copiedLabel: 'Copied',
        reveal: { chunks, caret },
      }),
    )

  it('wraps recently revealed text and appends the caret to the last block', () => {
    const html = render('Hey **world** friend', [{ start: 4, born: 123 }])
    expect(html).toContain('<p class="my-2">Hey <strong><span data-reveal-born="123">world</span></strong>')
    expect(html).toContain('<span data-reveal-born="123"> friend</span><span class="stream-caret"')
  })

  it('splits a text node at the chunk boundary', () => {
    const html = render('one two three', [{ start: 7, born: 5 }], false)
    expect(html).toContain('<p class="my-2">one two<span data-reveal-born="5"> three</span></p>')
  })

  it('never touches code blocks', () => {
    const html = render('```bash\nsudo apt update\n```', [{ start: 0, born: 1 }])
    expect(html).toContain('<code>sudo apt update</code>')
    expect(html).not.toContain('data-reveal-born')
  })

  it('renders plain markdown without decorations', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: 'hi', copyLabel: 'c', copiedLabel: 'd' }),
    )
    expect(html).not.toContain('stream-caret')
  })
})

describe('Markdown ids and /workspace paths', () => {
  const ULID = '01m41qvydqnjxef4ax623he0my'
  const card = `bcd_${ULID}`
  const renderers: RefLinkRenderers = {
    renderRef: (id, label) => createElement('a', { 'data-ref': id }, label ?? `name of ${id}`),
    renderPath: (path, variant, label) =>
      createElement('a', { 'data-path': path, 'data-variant': variant }, label ?? path),
  }
  const render = (text: string, withProvider = true) => {
    const markdown = createElement(Markdown, { text, copyLabel: 'Copy', copiedLabel: 'Copied' })
    return renderToStaticMarkup(
      withProvider ? createElement(RefLinkContext.Provider, { value: renderers }, markdown) : markdown,
    )
  }

  it('links ids in text, lists, tables and emphasis', () => {
    const html = render(`Card ${card}.\n\n- **brd_${ULID}**\n\n| a |\n|---|\n| plan_${ULID} |`)
    expect(html).toContain(`<a data-ref="${card}">name of ${card}</a>.`)
    expect(html).toContain(`<strong><a data-ref="brd_${ULID}">`)
    expect(html).toContain(`<a data-ref="plan_${ULID}">`)
  })

  it('keeps ids in code as code', () => {
    const html = render(`\`${card}\`\n\n\`\`\`\n${card}\n\`\`\``)
    expect(html).not.toContain('data-ref')
    expect(html).toContain(card)
  })

  it('leaves tool names and other ids as text', () => {
    expect(render(`plan_submit and msg_${ULID}`)).not.toContain('data-ref')
  })

  it('takes a label written for an id or a path', () => {
    const html = render(`[the card](${card}) and [notes](/workspace/a/NOTES.md)`)
    expect(html).toContain(`<a data-ref="${card}">the card</a>`)
    expect(html).toContain('<a data-path="/workspace/a/NOTES.md" data-variant="text">notes</a>')
  })

  it('links /workspace paths in text and in inline code', () => {
    const html = render('Saved to /workspace/a/NOTES.md. See `/workspace/b.png` and `/home/agent/x`')
    expect(html).toContain(
      '<a data-path="/workspace/a/NOTES.md" data-variant="text">/workspace/a/NOTES.md</a>.',
    )
    expect(html).toContain('<a data-path="/workspace/b.png" data-variant="chip">')
    expect(html).not.toContain('data-path="/home')
    expect(html).toContain('/home/agent/x')
  })

  it('keeps external links external', () => {
    const html = render('[site](https://example.com) https://example.org')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('href="https://example.org"')
  })

  it('shows plain text without the provider', () => {
    const html = render(`Card ${card} at /workspace/a.md`, false)
    expect(html).toContain(`Card ${card} at /workspace/a.md`)
    expect(html).not.toContain('<a')
  })

  it('keeps the fade of streamed text around an id', () => {
    const html = renderToStaticMarkup(
      createElement(
        RefLinkContext.Provider,
        { value: renderers },
        createElement(Markdown, {
          text: `See ${card} now`,
          reveal: { chunks: [{ start: 34, born: 7 }], caret: false },
        }),
      ),
    )
    expect(html).toContain('<span data-reveal-born="7"> now</span>')
  })
})
