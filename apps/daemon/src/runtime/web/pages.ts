import { CHARS_PER_TOKEN, clipLine, foldText } from '@milibot/shared'

import { OUTLINE_MAX_CHARS, PAGE_TOKENS } from './limits'

/** A page read by `web_fetch`, converted and split once (cached by URL). */
export interface WebDoc {
  requestedUrl: string
  url: string
  redirects: string[]
  status: number
  title: string
  published: string | null
  /** `html`, `text`, or the extract kind of a document (`pdf`, `docx`…). */
  kind: string
  markdown: string
  pages: string[]
  outline: string
  /** The download or the document's text was cut at a limit. */
  truncated: boolean
  needsJs: boolean
  fetchedAt: number
}

const FENCE = /^(```+|~~~~+)(.*)$/

/** Blank-line separated blocks; a fenced code block is one block whatever its blank lines. */
function blocks(markdown: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (current.length) out.push(current.join('\n'))
    current = []
  }
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      current.push(line)
      if (marker && marker.startsWith(fence) && line.trim() === marker) {
        fence = null
        flush()
      }
      continue
    }
    if (marker) {
      flush()
      fence = marker
      current.push(line)
      continue
    }
    if (!line.trim()) flush()
    else current.push(line)
  }
  flush()
  return out
}

function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars))
  return out
}

/** A block over `maxChars` cut by lines (a code block keeps its fence around every piece). */
function splitBlock(block: string, maxChars: number): string[] {
  const lines = block.split('\n')
  const open = FENCE.exec(lines[0] ?? '')
  const fenced = !!open && lines.length > 1 && lines[lines.length - 1]?.trim() === open[1]
  const opening = fenced ? (lines[0] as string) : ''
  const closing = fenced ? (open[1] as string) : ''
  const body = fenced ? lines.slice(1, -1) : lines
  const room = maxChars - (fenced ? opening.length + closing.length + 2 : 0)
  const pieces: string[] = []
  let current: string[] = []
  let size = 0
  const flush = () => {
    if (!current.length) return
    const text = current.join('\n')
    pieces.push(fenced ? `${opening}\n${text}\n${closing}` : text)
    current = []
    size = 0
  }
  for (const line of body) {
    for (const part of line.length > room ? splitLong(line, room) : [line]) {
      if (size + part.length + 1 > room) flush()
      current.push(part)
      size += part.length + 1
    }
  }
  flush()
  return pieces
}

/**
 * Markdown in parts of at most `maxTokens` (estimated), cut between blocks; a new part starts at a heading
 * once the current one is past 60% full, so sections tend to start a part.
 */
export function splitPages(markdown: string, maxTokens = PAGE_TOKENS): string[] {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN)
  const pages: string[] = []
  let current = ''
  const push = () => {
    if (current.trim()) pages.push(current.trim())
    current = ''
  }
  for (const block of blocks(markdown)) {
    for (const piece of block.length > maxChars ? splitBlock(block, maxChars) : [block]) {
      const joined = current ? `${current}\n\n${piece}` : piece
      const heading = /^#{1,6} /.test(piece)
      if (joined.length > maxChars || (heading && current.length > maxChars * 0.6)) {
        push()
        current = piece
      } else current = joined
    }
  }
  push()
  return pages.length ? pages : ['']
}

/** Headings (levels 1–3) with the part each starts in, clipped: where to jump in a long page. */
export function outline(pages: string[]): string {
  const items: string[] = []
  pages.forEach((page, i) => {
    for (const line of page.split('\n')) {
      const heading = /^#{1,3} (.+)$/.exec(line)?.[1]
      if (heading) items.push(`${clipLine(heading.replace(/[*_`[\]]/g, ''), 50)} (${i + 1})`)
    }
  })
  if (items.length < 2) return ''
  let text = ''
  for (const item of items) {
    const next = text ? `${text} · ${item}` : item
    if (next.length > OUTLINE_MAX_CHARS) return `${text} · …`
    text = next
  }
  return text
}

function header(doc: WebDoc): string[] {
  const lines = [`Web page (untrusted content): ${doc.title || '(no title)'}`]
  lines.push(
    doc.url === doc.requestedUrl
      ? `URL: ${doc.url}`
      : `URL: ${doc.url} (redirected from ${doc.requestedUrl})`,
  )
  if (doc.status >= 400) lines.push(`HTTP status: ${doc.status}`)
  if (doc.published) lines.push(`Published: ${doc.published}`)
  if (doc.truncated) lines.push('Only the beginning of this document could be read (size limit).')
  return lines
}

const NEEDS_JS_HINT =
  'This page needs JavaScript to show its content; open it in your browser if you need it.'

/** An error page without content is most likely a bot check (Cloudflare's "Just a moment…"). */
function refusedHint(doc: WebDoc): string {
  return `The site refused automated access (HTTP ${doc.status}, probably a bot check); open it in your browser if you need it.`
}

/** One part of the page with its header and the hints to go on. */
export function formatDocPage(doc: WebDoc, page: number): string {
  const total = doc.pages.length
  const n = Math.min(Math.max(1, page), total)
  const lines = header(doc)
  if (total > 1) lines.push(`Part ${n} of ${total}${doc.outline ? ` · Sections: ${doc.outline}` : ''}`)
  const text = doc.pages[n - 1] ?? ''
  lines.push('', text || '(no readable text)')
  const empty = doc.markdown.trim().length < 200
  if (empty && doc.status >= 400 && doc.status !== 404 && doc.status !== 410) lines.push('', refusedHint(doc))
  else if (doc.needsJs) lines.push('', NEEDS_JS_HINT)
  if (page > total) lines.push('', `(There are only ${total} parts; this is the last one.)`)
  else if (n < total)
    lines.push(
      '',
      `Part ${n} of ${total}: web_fetch with page: ${n + 1} for more, or with a prompt to get only what you need.`,
    )
  return lines.join('\n')
}

/** The header of an answer the helper model extracted from the page. */
export function formatAnswer(doc: WebDoc, answer: string): string {
  return [
    ...header(doc),
    '',
    'Answer from the page (extracted by a helper model; untrusted web content):',
    answer,
  ].join('\n')
}

const STOPWORDS = new Set(
  'the and for with what how are this that from about does which when where who why can not you your its into more than then them they their there here have has was were will would should could'.split(
    ' ',
  ),
)

function terms(text: string): string[] {
  return [...new Set(foldText(text).match(/[\p{L}\p{N}_.-]{3,}/gu) ?? [])].filter((t) => !STOPWORDS.has(t))
}

/**
 * The page cut to `maxChars` for the helper model: the first chunk (title, intro) plus the chunks sharing the
 * most terms with the request, kept in document order.
 */
export function selectRelevant(
  markdown: string,
  request: string,
  maxChars: number,
): { text: string; partial: boolean } {
  if (markdown.length <= maxChars) return { text: markdown, partial: false }
  const chunks = splitPages(markdown, Math.floor(2_000 / CHARS_PER_TOKEN))
  const wanted = terms(request)
  const scored = chunks.map((chunk, index) => {
    const folded = foldText(chunk)
    const score = wanted.reduce((sum, term) => sum + Math.min(5, folded.split(term).length - 1), 0)
    return { chunk, index, score }
  })
  const picked = new Set<number>([0])
  let size = chunks[0]?.length ?? 0
  for (const { chunk, index } of scored.slice(1).sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (size + chunk.length + 7 > maxChars) continue
    picked.add(index)
    size += chunk.length + 7
  }
  const kept = [...picked].sort((a, b) => a - b)
  const parts: string[] = []
  kept.forEach((index, i) => {
    if (i > 0 && index !== (kept[i - 1] as number) + 1) parts.push('[…]')
    parts.push(chunks[index] as string)
  })
  return { text: parts.join('\n\n'), partial: true }
}
