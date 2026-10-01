import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

import { HTML_PARSE_MAX_CHARS } from './limits'

export interface HtmlPage {
  title: string
  markdown: string
  published: string | null
  /** Characters of readable text: tiny pages with an app root most likely need JavaScript. */
  textChars: number
  needsJs: boolean
}

const NOISE =
  'script, style, noscript, template, svg, canvas, iframe, button, select, textarea, nav, header, footer, aside, ' +
  '[aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], [hidden]'
const APP_ROOT = '#root, #app, #__next, #__nuxt, [data-reactroot], app-root'
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_hsenc|_hsmi|ref_src)$/i
const MAX_LINK_CHARS = 300

type ReadabilityDocument = ConstructorParameters<typeof Readability>[0]

/** A link as the bot should read it: absolute, without tracking parameters; null drops the link (keeps text). */
export function cleanLink(href: string, base: string): string | null {
  const value = href.trim()
  if (!value || value.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(value)) return null
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
  const text = url.href
  return text.length > MAX_LINK_CHARS ? null : text
}

function turndown(base: string): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  })
  service.use(gfm)
  // Rules added here run before the built-in ones (`remove` would lose to the image rule).
  service.addRule('drop', {
    filter: [
      'script',
      'style',
      'noscript',
      'template',
      'iframe',
      'svg',
      'canvas',
      'img',
      'picture',
      'video',
      'audio',
      'button',
      'select',
      'textarea',
      'input',
    ],
    replacement: () => '',
  })
  service.addRule('link', {
    filter: (node) => node.nodeName === 'A' && !!node.getAttribute('href'),
    replacement: (content, node) => {
      const text = content.replace(/\s+/g, ' ').trim()
      const href = cleanLink(node.getAttribute('href') ?? '', base)
      // Permalink marks ("#", "¶") next to headings are noise without their link.
      if (!href) return /[\p{L}\p{N}]/u.test(text) ? text : ''
      if (!text) return ''
      return text === href || text === href.replace(/\/$/, '') ? `<${href}>` : `[${text}](${href})`
    },
  })
  service.addRule('fencedCode', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const element = node
      const code = element.querySelector('code')
      const classes = `${code?.getAttribute('class') ?? ''} ${element.getAttribute('class') ?? ''}`
      const language = /(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? ''
      const text = (code ?? element).textContent?.replace(/\n$/, '') ?? ''
      const fence = text.includes('```') ? '~~~~' : '```'
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`
    },
  })
  return service
}

/** Readable text of a document, collapsed: what the "is this page empty" checks measure. */
function textLength(node: { textContent: string | null } | null): number {
  return node?.textContent?.replace(/\s+/g, ' ').trim().length ?? 0
}

function tidyMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  let inFence = false
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '')
    if (/^(```|~~~~)/.test(line)) inFence = !inFence
    if (!inFence && line && line === kept[kept.length - 1]) continue
    kept.push(
      inFence ? line : line.replace(/^\\?\[Milibot\\?\]/, '[quoted]').replace(/(\S) {2,}(?=\S)/g, '$1 '),
    )
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Main content of an HTML page as Markdown (Readability's article, else the page without its chrome). */
export function htmlToMarkdown(html: string, baseUrl: string): HtmlPage {
  const { document } = parseHTML(
    html.length > HTML_PARSE_MAX_CHARS ? html.slice(0, HTML_PARSE_MAX_CHARS) : html,
  )
  const title = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const published =
    document
      .querySelector(
        'meta[property="article:published_time"], meta[name="date"], meta[name="publish-date"], meta[itemprop="datePublished"]',
      )
      ?.getAttribute('content') ??
    document.querySelector('time[datetime]')?.getAttribute('datetime') ??
    null
  const needsJsRoot = !!document.querySelector(APP_ROOT)

  const cleaned = document.cloneNode(true) as typeof document
  for (const node of [...cleaned.querySelectorAll(NOISE)]) node.remove()
  const main =
    cleaned.querySelector('main, article, [role="main"]') ?? cleaned.body ?? cleaned.documentElement
  const mainChars = textLength(main)

  let articleHtml: string | null = null
  let articleTitle: string | null = null
  try {
    const article = new Readability(document.cloneNode(true) as unknown as ReadabilityDocument, {
      keepClasses: true,
    }).parse()
    if (article?.content && (article.textContent?.length ?? 0) >= Math.max(500, mainChars * 0.3)) {
      articleHtml = article.content
      articleTitle = article.title ?? null
    }
  } catch {
    // Readability gives up on odd documents: the cleaned page is used instead.
  }
  const service = turndown(baseUrl)
  const markdown = tidyMarkdown(service.turndown(articleHtml ?? main?.innerHTML ?? ''))
  const textChars = articleHtml ? markdown.length : mainChars
  return {
    title: articleTitle?.trim() || title,
    markdown,
    published: published?.trim() || null,
    textChars,
    needsJs:
      (needsJsRoot && textChars < 500) || (textChars < 50 && document.querySelectorAll('script').length > 0),
  }
}

/** Plain text, Markdown and JSON as the bot reads them (JSON indented so it splits by lines). */
export function textToMarkdown(body: string, contentType: string | null): string {
  if (contentType && /json/.test(contentType)) {
    try {
      return JSON.stringify(JSON.parse(body), null, 1)
    } catch {
      return body.trim()
    }
  }
  return tidyMarkdown(body)
}
