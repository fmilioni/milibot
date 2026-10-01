import { type ExtractResult, MAX_EXTRACT_BYTES } from '@milibot/shared'

import { clipMiddle } from '../tools-core'
import { type GuestClient, GuestError } from '../vm'
import { decodeText, isLegacyOfficeKind, sniffFile } from './sniff'

const FIRST_CHUNK_BYTES = 1024 * 1024
const NEXT_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_TEXT_BYTES = 32 * 1024 * 1024
const DEFAULT_READ_LINES = 2000
const DEFAULT_DOC_PAGES = 20
const MAX_DOC_CHARS = 50_000
const MAX_TEXT_CHARS = 60_000

/** LibreOffice in the VM (old Office formats) as `file_read` sees it. */
export interface LegacyOfficeAccess {
  enabled: boolean
  /** Being installed right now (`progress` 0..1 when known). */
  installing: boolean
  progress: number | null
}

export interface FileReadOptions {
  offset?: number
  limit?: number
  signal?: AbortSignal
  legacyOffice?: LegacyOfficeAccess
}

export interface FileReadOutput {
  text: string
  isError?: boolean
}

const KIND_LABELS: Record<string, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  odt: 'OpenDocument text',
  epub: 'EPUB book',
  rtf: 'RTF document',
  html: 'HTML page',
  xlsx: 'Excel spreadsheet',
  pptx: 'PowerPoint presentation',
  doc: 'Word 97-2003 document',
  xls: 'Excel 97-2003 spreadsheet',
  ppt: 'PowerPoint 97-2003 presentation',
  ods: 'OpenDocument spreadsheet',
  odp: 'OpenDocument presentation',
  image: 'image',
}

const SHEET_KINDS = new Set(['xlsx', 'xls', 'ods'])
const SLIDE_KINDS = new Set(['pptx', 'ppt', 'odp'])

function pageList(pages: number[]): string {
  const ranges: string[] = []
  for (let i = 0; i < pages.length; i++) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++
    ranges.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`)
    i = j
  }
  return ranges.join(', ')
}

async function readRest(
  guest: GuestClient,
  path: string,
  first: Buffer,
  size: number,
  max: number,
): Promise<Buffer> {
  const parts = [first]
  let offset = first.length
  const end = Math.min(size, max)
  while (offset < end) {
    const chunk = await guest.fsReadChunk(path, offset, Math.min(NEXT_CHUNK_BYTES, end - offset))
    const bytes = Buffer.from(chunk.content, 'base64')
    if (bytes.length === 0) break
    parts.push(bytes)
    offset += bytes.length
  }
  return Buffer.concat(parts)
}

function numberedLines(path: string, content: string, offset: number, limit: number): string {
  const lines = content.split('\n')
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n')
  const more =
    offset - 1 + limit < lines.length ? `\n… ${lines.length - (offset - 1 + limit)} more lines` : ''
  return clipMiddle(`${path} (${lines.length} lines)\n${numbered}${more}`, MAX_TEXT_CHARS)
}

/** Extracted pages with `--- page N ---` markers; `offset`/`limit` count pages. */
function formatExtracted(path: string, result: ExtractResult, offset: number, limit: number): string {
  const { meta } = result
  const unit = SHEET_KINDS.has(result.kind) ? 'sheet' : SLIDE_KINDS.has(result.kind) ? 'slide' : 'page'
  const label = KIND_LABELS[result.kind] ?? result.kind
  const ocrPages = result.pages.filter((p) => p.ocr).map((p) => p.n)
  const header = [
    `${path} — ${label}${meta.title ? ` "${meta.title}"` : ''}, ${meta.pageCount} ${meta.pseudoPages ? 'sections' : `${unit}s`}`,
    meta.pseudoPages ? ' (no real pages: each "page" below is a section of the document)' : '',
    ocrPages.length
      ? `; text of ${ocrPages.length === 1 ? unit : `${unit}s`} ${pageList(ocrPages)} read by OCR, may contain errors`
      : '',
  ].join('')
  const wanted = result.pages.filter((p) => p.n >= offset && p.n < offset + limit)
  if (wanted.length === 0) {
    return `${header}\nNothing from page ${offset}: the document has ${meta.pageCount} ${meta.pseudoPages ? 'sections' : `${unit}s`}.`
  }
  const out: string[] = [header]
  let used = header.length
  let lastShown = offset - 1
  for (const page of wanted) {
    const title = page.title ? ` · ${unit} "${page.title}"` : ''
    const block = `--- page ${page.n}${title}${page.ocr ? ' (OCR)' : ''} ---\n${page.text || '(no text)'}`
    if (used + block.length > MAX_DOC_CHARS && lastShown >= offset) break
    out.push(
      used + block.length > MAX_DOC_CHARS ? `${block.slice(0, MAX_DOC_CHARS - used)}\n… [page cut]` : block,
    )
    used += block.length
    lastShown = page.n
  }
  const lastPage = result.pages.at(-1)?.n ?? meta.pageCount
  const total = Math.max(meta.pageCount, lastPage)
  if (lastShown < total) {
    out.push(
      `[${total > lastShown + 1 ? `Pages ${lastShown + 1}–${total}` : `Page ${total}`} not shown: call file_read with offset=${lastShown + 1}.]`,
    )
  }
  const skipped = meta.ocrSkipped.filter((n) => n >= offset && n <= lastShown)
  if (skipped.length)
    out.push(
      `[${skipped.length === 1 ? 'Page' : 'Pages'} ${pageList(skipped)} without a text layer not OCR'd (limit per call): read them with a smaller offset/limit range.]`,
    )
  if (meta.truncated && lastShown >= lastPage)
    out.push('[The document is longer than the extraction limit; the end is missing.]')
  return out.join('\n')
}

function binaryMessage(path: string, description: string): string {
  return (
    `${path} is a binary file (${description}), not text; file_read only reads text files and documents ` +
    `(PDF, Word/OpenDocument/EPUB/RTF, xlsx, pptx, images; old .doc/.xls/.ppt with LibreOffice). Use bash to inspect or convert it ` +
    `(e.g. \`file\`, \`unzip -l\`, \`tar -tf\`, \`xxd | head\`).`
  )
}

function legacyOfficeMessage(path: string, access: LegacyOfficeAccess | undefined): string {
  if (access?.installing) {
    const percent = access.progress === null ? '' : ` (${Math.round(access.progress * 100)}%)`
    return `${path} is an old Office/OpenDocument file; LibreOffice is being installed in the VM to read it${percent}. Try again in a minute.`
  }
  if (access?.enabled)
    return `${path} is an old Office/OpenDocument file and LibreOffice is not installed in the VM yet (the install failed or has not run). Ask the user to check "Old Office files" in Settings › Knowledge.`
  return (
    `${path} is an old Office/OpenDocument file (.doc/.xls/.ppt/.ods/.odp). Reading it needs "Old Office files" ` +
    `turned on in the workspace settings (Settings › Knowledge), which installs LibreOffice in the VM (~360 MB). ` +
    `Ask the user to turn it on, or ask them for a .docx/.xlsx/.pptx/PDF version.`
  )
}

function extractError(path: string, err: GuestError, access: LegacyOfficeAccess | undefined): FileReadOutput {
  switch (err.code) {
    case 'office_missing':
      return { text: legacyOfficeMessage(path, access && { ...access, installing: false }), isError: true }
    case 'unsupported_format':
      return { text: binaryMessage(path, 'a format that cannot be converted to text'), isError: true }
    case 'tools_missing':
      return {
        text: `The VM lacks the document tools (${err.message}); the user can install them with a VM system update. Meanwhile, use bash.`,
        isError: true,
      }
    case 'timeout':
      return {
        text: `Extracting the text of ${path} took too long; read fewer pages with offset/limit.`,
        isError: true,
      }
    case 'too_large':
      return {
        text: `${path} is larger than ${MAX_EXTRACT_BYTES / 1024 / 1024} MB; use bash tools.`,
        isError: true,
      }
    default:
      return { text: `Could not extract the text of ${path} (${err.code}): ${err.message}`, isError: true }
  }
}

/** `file_read`: text with numbered lines; documents extracted in the VM; other binaries refused. */
export async function readFileForTool(
  guest: GuestClient,
  path: string,
  options: FileReadOptions = {},
): Promise<FileReadOutput> {
  const offset = options.offset !== undefined ? Math.max(1, Math.round(options.offset)) : 1
  const first = await guest.fsReadChunk(path, 0, FIRST_CHUNK_BYTES)
  const head = Buffer.from(first.content, 'base64')
  const sniff = sniffFile(path, head)
  if (sniff.type === 'binary') return { text: binaryMessage(first.path, sniff.description), isError: true }
  if (sniff.type === 'text') {
    const bytes = first.truncated ? await readRest(guest, path, head, first.size, MAX_TEXT_BYTES) : head
    const limit = options.limit !== undefined ? Math.max(1, Math.round(options.limit)) : DEFAULT_READ_LINES
    return { text: numberedLines(first.path, decodeText(bytes), offset, limit) }
  }
  if (isLegacyOfficeKind(sniff.kind) && (!options.legacyOffice?.enabled || options.legacyOffice.installing))
    return { text: legacyOfficeMessage(first.path, options.legacyOffice), isError: true }
  if (first.size > MAX_EXTRACT_BYTES) {
    return {
      text: `${first.path} is larger than ${MAX_EXTRACT_BYTES / 1024 / 1024} MB; use bash tools.`,
      isError: true,
    }
  }
  const limit = options.limit !== undefined ? Math.max(1, Math.round(options.limit)) : DEFAULT_DOC_PAGES
  const bytes = first.truncated ? await readRest(guest, path, head, first.size, MAX_EXTRACT_BYTES) : head
  try {
    const result = await guest.extract(bytes, {
      name: first.path,
      ...(sniff.kind ? { kind: sniff.kind } : {}),
      pages: { first: offset, last: offset + limit - 1 },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { text: formatExtracted(first.path, result, offset, limit) }
  } catch (err) {
    if (err instanceof GuestError && err.status !== 0)
      return extractError(first.path, err, options.legacyOffice)
    throw err
  }
}
