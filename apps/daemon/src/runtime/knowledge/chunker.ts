import { estimateTokens } from '@milibot/shared'

import { sha256 } from '../../util/hash'

/** `<!-- page N -->` on its own line: where page N of the extracted text starts in `content.md`. */
const PAGE_MARKER = /^<!-- page (\d+) -->[ \t]*$/
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/

export const DEFAULT_CHUNK_TOKENS = 600
const DEFAULT_CHUNK_OVERLAP_TOKENS = 80
const CHARS_PER_TOKEN = 3.5

export interface ChunkDraft {
  /** 1-based order in the document. */
  seq: number
  pageFrom: number | null
  pageTo: number | null
  /** Heading path at the start of the chunk ("Contract › Payment"), '' when none. */
  heading: string
  text: string
  tokens: number
  /** Of the embedded text (heading + text): an unchanged chunk keeps its vector. */
  sha256: string
  /** Offsets of the chunk in `content.md`. */
  charStart: number
  charEnd: number
}

export interface ChunkOptions {
  targetTokens?: number
  overlapTokens?: number
  /** Hard cap of one chunk (the embedding model's input limit). */
  maxTokens?: number
  /** CSV: the first line (header) is repeated at the top of every chunk. */
  csv?: boolean
  /** Real pages (PDF, slides, sheets): a chunk never spans two of them, so hits cite one page. */
  pageBreaks?: boolean
}

interface Block {
  start: number
  end: number
  page: number | null
  path: string[]
  heading: number | null
  tokens: number
}

/** Text the embedding model reads for a chunk (the heading path gives it context). */
export function embeddingText(heading: string, text: string): string {
  return heading ? `${heading}\n\n${text}` : text
}

function chunkSha(heading: string, text: string): string {
  return sha256(embeddingText(heading, text))
}

/** Page markers become a blank line; the text between them stays as is. */
export function stripPageMarkers(text: string): string {
  return text
    .split('\n')
    .filter((line) => !PAGE_MARKER.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Pages of a `content.md`: page number (null without markers) and the offsets of its text. */
export function contentPages(content: string): Array<{ n: number | null; start: number; end: number }> {
  const pages: Array<{ n: number | null; start: number; end: number }> = []
  let offset = 0
  let current: { n: number | null; start: number } | null = null
  for (const line of content.split('\n')) {
    const marker = PAGE_MARKER.exec(line)
    if (marker) {
      if (current) pages.push({ ...current, end: offset })
      else if (content.slice(0, offset).trim()) pages.push({ n: null, start: 0, end: offset })
      current = { n: Number(marker[1]), start: offset + line.length + 1 }
    }
    offset += line.length + 1
  }
  const end = content.length
  if (current) pages.push({ ...current, start: Math.min(current.start, end), end })
  else pages.push({ n: null, start: 0, end })
  return pages
}

/** Paragraphs (runs of non-blank lines) with their page and heading path; headings are blocks of their own. */
function blocks(content: string): Block[] {
  const out: Block[] = []
  const path: Array<{ level: number; text: string }> = []
  let page: number | null = null
  let offset = 0
  let open: Block | null = null
  const close = () => {
    if (open) {
      open.tokens = estimateTokens(content.slice(open.start, open.end))
      out.push(open)
    }
    open = null
  }
  for (const line of content.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + 1
    const marker = PAGE_MARKER.exec(line)
    if (marker) {
      close()
      page = Number(marker[1])
      continue
    }
    if (!line.trim()) {
      close()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      close()
      const level = (heading[1] as string).length
      while (path.length && (path.at(-1) as { level: number }).level >= level) path.pop()
      path.push({ level, text: (heading[2] as string).trim() })
      out.push({
        start: lineStart,
        end: lineEnd,
        page,
        path: path.map((p) => p.text),
        heading: level,
        tokens: estimateTokens(line),
      })
      continue
    }
    if (open) (open as Block).end = lineEnd
    else
      open = { start: lineStart, end: lineEnd, page, path: path.map((p) => p.text), heading: null, tokens: 0 }
  }
  close()
  return out
}

/** Cuts a block larger than `maxTokens` at line ends, then sentence ends, then whitespace. */
function splitBlock(content: string, block: Block, maxTokens: number): Block[] {
  const maxChars = Math.max(200, Math.floor(maxTokens * CHARS_PER_TOKEN))
  const pieces: Block[] = []
  let start = block.start
  while (start < block.end) {
    let end = Math.min(block.end, start + maxChars)
    if (end < block.end) {
      const window = content.slice(start, end)
      const cut =
        [window.lastIndexOf('\n'), sentenceEnd(window), window.lastIndexOf(' ')].find(
          (i) => i > maxChars * 0.5,
        ) ?? -1
      if (cut > 0) end = start + cut + 1
    }
    const text = content.slice(start, end)
    if (text.trim()) pieces.push({ ...block, start, end, tokens: estimateTokens(text) })
    start = end
  }
  return pieces
}

function sentenceEnd(text: string): number {
  let last = -1
  for (const match of text.matchAll(/[.!?;:](?=\s)/g)) last = match.index ?? last
  return last
}

/** Start of the overlap: `overlapChars` before `end`, moved to the next whitespace. */
function overlapStart(content: string, blockStart: number, end: number, overlapChars: number): number {
  if (overlapChars <= 0) return end
  const from = Math.max(blockStart, end - overlapChars)
  const space = content.slice(from, end).search(/\s/)
  return space < 0 ? end : from + space + 1
}

/**
 * Cuts `content.md` into chunks of about `targetTokens` (estimated), never above `maxTokens`, starting a new
 * chunk at headings and pages once the current one is half full (at every page with `pageBreaks`);
 * consecutive chunks of the same section overlap by about `overlapTokens`.
 */
export function chunkContent(content: string, options: ChunkOptions = {}): ChunkDraft[] {
  const maxTokens = Math.max(64, options.maxTokens ?? DEFAULT_CHUNK_TOKENS * 1.5)
  const target = Math.max(32, Math.min(options.targetTokens ?? DEFAULT_CHUNK_TOKENS, maxTokens))
  const overlapChars = Math.floor(
    Math.min(options.overlapTokens ?? DEFAULT_CHUNK_OVERLAP_TOKENS, target / 4) * CHARS_PER_TOKEN,
  )
  let header = ''
  let all = blocks(content)
  if (options.csv) {
    const first = all[0]
    if (first) {
      const firstLine = content.slice(first.start, first.end).split('\n')[0] ?? ''
      header = firstLine.trim()
    }
    // Rows are lines: every line is a block so chunks end at row boundaries.
    all = all.flatMap((b) => {
      const lines: Block[] = []
      let at = b.start
      for (const line of content.slice(b.start, b.end).split('\n')) {
        if (line.trim()) lines.push({ ...b, start: at, end: at + line.length, tokens: estimateTokens(line) })
        at += line.length + 1
      }
      return lines
    })
    if (header && all[0] && content.slice(all[0].start, all[0].end).trim() === header) all.shift()
  }
  const headerTokens = header ? estimateTokens(header) + 1 : 0
  const room = maxTokens - headerTokens
  const pieces = all.flatMap((b) => (b.tokens > room ? splitBlock(content, b, room) : [b]))

  const drafts: ChunkDraft[] = []
  let current: Block[] = []
  let currentTokens = 0
  let carryStart: number | null = null
  const flush = (): number | null => {
    if (!current.length) return null
    const first = current[0] as Block
    const last = current.at(-1) as Block
    const start = carryStart !== null && carryStart < first.start ? carryStart : first.start
    const body = stripPageMarkers(content.slice(start, last.end))
    const text = header ? `${header}\n${body}` : body
    const heading = first.path.join(' › ')
    if (body) {
      drafts.push({
        seq: drafts.length + 1,
        pageFrom: first.page,
        pageTo: last.page,
        heading,
        text,
        tokens: estimateTokens(text),
        sha256: chunkSha(heading, text),
        charStart: start,
        charEnd: last.end,
      })
    }
    current = []
    currentTokens = 0
    carryStart = null
    return last.end
  }
  for (const block of pieces) {
    const prev = current.at(-1)
    const boundary =
      prev !== undefined && ((block.heading !== null && block.heading <= 3) || block.page !== prev.page)
    const full = currentTokens + block.tokens + headerTokens > target
    const newPage = options.pageBreaks === true && prev !== undefined && block.page !== prev.page
    if (prev && (full || newPage || (boundary && currentTokens >= target / 2))) {
      const sameSection = !boundary && block.heading === null
      const lastBlock = prev
      const end = flush()
      if (sameSection && end !== null && !header) {
        const carried = overlapStart(content, lastBlock.start, end, overlapChars)
        const carriedTokens = estimateTokens(content.slice(carried, end))
        if (carried < end && carriedTokens + block.tokens <= maxTokens) {
          carryStart = carried
          currentTokens = carriedTokens
        }
      }
    }
    current.push(block)
    currentTokens += block.tokens
  }
  flush()
  return drafts
}
