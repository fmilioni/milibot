import type { ExtractedPage } from '@milibot/shared/portable/guest-api'

/** UTF-8 (BOM removed), UTF-16 with BOM, otherwise Latin-1 when the bytes are not valid UTF-8. */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}

function cleanLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

/** `pdftotext` ends every page with a form feed; page `i` of the output is page `first + i` of the PDF. */
export function splitPdfText(output: string, first = 1): ExtractedPage[] {
  const parts = output.split('\f')
  if (parts.length > 1 && parts.at(-1)!.trim() === '') parts.pop()
  return parts.map((part, i) => ({ n: first + i, text: cleanLines(part), ocr: false }))
}

/** Too little text for a real text layer: a scan, or a page whose text is drawn as images. */
export function needsOcr(page: ExtractedPage): boolean {
  return page.text.replace(/\s+/g, '').length < 16
}

export interface PdfInfo {
  pages: number | null
  title?: string
  encrypted: boolean
}

export function parsePdfInfo(output: string): PdfInfo {
  const fields = new Map<string, string>()
  for (const line of output.split('\n')) {
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(line)
    if (m && !fields.has(m[1]!)) fields.set(m[1]!, m[2]!.trim())
  }
  const pages = Number(fields.get('Pages'))
  const title = fields.get('Title')
  return {
    pages: Number.isInteger(pages) && pages > 0 ? pages : null,
    ...(title ? { title } : {}),
    encrypted: /^yes/i.test(fields.get('Encrypted') ?? ''),
  }
}

/** Marker between the title and the body in the pandoc template. */
export const PANDOC_BODY_MARKER = '@@milibot-extract-body@@'
export const PANDOC_TEMPLATE = `$if(title)$$title$\n$endif$${PANDOC_BODY_MARKER}\n$body$\n`

export function splitPandocOutput(output: string): { title?: string; body: string } {
  const at = output.indexOf(PANDOC_BODY_MARKER)
  if (at < 0) return { body: output }
  const title = output.slice(0, at).replace(/\s+/g, ' ').trim()
  const body = output.slice(at + PANDOC_BODY_MARKER.length).replace(/^\n/, '')
  return { ...(title ? { title } : {}), body }
}

/**
 * Wrapper-only HTML lines that pandoc keeps in gfm for divs and spans (EPUB chapters, custom styles); HTML
 * tables stay, as `gfm-raw_html` would replace complex tables with "[TABLE]".
 */
export function stripHtmlWrappers(md: string): string {
  let fence: string | null = null
  return md
    .split('\n')
    .filter((line) => {
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1]![0]!
        else if (fenceMatch[1]![0] === fence) fence = null
      }
      return fence !== null || !/^\s*<\/?(div|section|span)(\s[^>]*)?>\s*$/i.test(line)
    })
    .join('\n')
}

export interface PaginateOptions {
  /** A page closes at the first boundary after this size. */
  targetChars?: number
  /** A level 1–2 heading starts a new page once the current one has this much. */
  minChars?: number
  /** Hard size of a page: longer blocks are cut at paragraphs, then lines, then characters. */
  maxChars?: number
}

const DEFAULTS: Required<PaginateOptions> = { targetChars: 3500, minChars: 1200, maxChars: 6000 }

interface Block {
  text: string
  level: number
}

/** Sections of a markdown text: each one starts at a heading (fenced code is never split). */
function markdownBlocks(md: string): Block[] {
  const blocks: Block[] = []
  let current: string[] = []
  let level = 0
  let fence: string | null = null
  const flush = () => {
    if (current.some((l) => l.trim())) blocks.push({ text: current.join('\n'), level })
    current = []
  }
  for (const line of md.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]![0]!
      else if (fenceMatch[1]![0] === fence) fence = null
    }
    const heading = fence === null ? /^(#{1,6})\s/.exec(line) : null
    if (heading) {
      flush()
      level = heading[1]!.length
    }
    current.push(line)
  }
  flush()
  return blocks
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = []
  for (const sep of ['\n\n', '\n']) {
    if (!text.includes(sep)) continue
    let chunk = ''
    for (const piece of text.split(sep)) {
      const next = chunk ? chunk + sep + piece : piece
      if (next.length <= max) {
        chunk = next
        continue
      }
      if (chunk) out.push(chunk)
      if (piece.length <= max) chunk = piece
      else {
        out.push(...hardSplit(piece, max))
        chunk = ''
      }
    }
    if (chunk) out.push(chunk)
    return out
  }
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max))
  return out
}

function pack(blocks: Block[], options: PaginateOptions): string[] {
  const { targetChars, minChars, maxChars } = { ...DEFAULTS, ...options }
  const pages: string[] = []
  let page = ''
  const close = () => {
    if (page.trim()) pages.push(cleanLines(page))
    page = ''
  }
  for (const block of blocks) {
    const startsChapter = block.level > 0 && block.level <= 2 && page.length >= minChars
    if (startsChapter || page.length >= targetChars || page.length + block.text.length > maxChars) close()
    if (block.text.length > maxChars) {
      for (const part of hardSplit(block.text, targetChars)) {
        if (page.length + part.length > maxChars) close()
        page = page ? `${page}\n\n${part}` : part
        if (page.length >= targetChars) close()
      }
      continue
    }
    page = page ? `${page}\n\n${block.text}` : block.text
  }
  close()
  return pages
}

/** Pseudo-pages of a document without real pages (pandoc output), cut at headings so sections can be cited. */
export function paginateMarkdown(md: string, options: PaginateOptions = {}): ExtractedPage[] {
  return pack(markdownBlocks(md.replace(/\r\n?/g, '\n')), options).map((text, i) => ({
    n: i + 1,
    text,
    ocr: false,
  }))
}

/** Pseudo-pages of plain text (csv, code, logs): whole lines, about `targetChars` each. */
export function paginateLines(text: string, options: PaginateOptions = {}): ExtractedPage[] {
  const { targetChars, maxChars } = { ...DEFAULTS, ...options }
  const pages: string[] = []
  let page: string[] = []
  let size = 0
  const close = () => {
    if (page.length) pages.push(page.join('\n'))
    page = []
    size = 0
  }
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const lines = raw.length > maxChars ? hardSplit(raw, maxChars) : [raw]
    for (const line of lines) {
      if (size > 0 && size + line.length + 1 > targetChars) close()
      page.push(line)
      size += line.length + 1
    }
  }
  close()
  return pages
    .map((p) => p.replace(/\n+$/, ''))
    .filter((p) => p.trim().length > 0)
    .map((t, i) => ({ n: i + 1, text: t, ocr: false }))
}
