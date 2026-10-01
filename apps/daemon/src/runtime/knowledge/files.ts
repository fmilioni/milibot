import { extname, join } from 'node:path'

import {
  type ExtractKind,
  type ExtractResult,
  type KnowledgeKind,
  LEGACY_OFFICE_EXTENSIONS,
} from '@milibot/shared'

import type { FileSniff } from '../files'

function knowledgeRoot(workspaceDir: string): string {
  return join(workspaceDir, 'knowledge')
}

export function docDir(workspaceDir: string, docId: string): string {
  return join(knowledgeRoot(workspaceDir), docId)
}

/** Copy of the added file, keeping its extension (the download uses the original name). */
export function originalPath(workspaceDir: string, docId: string, fileName: string): string {
  const ext = extname(fileName).toLowerCase()
  return join(docDir(workspaceDir, docId), `original${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`)
}

export function contentPath(workspaceDir: string, docId: string): string {
  return join(docDir(workspaceDir, docId), 'content.md')
}

export function uploadsDir(workspaceDir: string): string {
  return join(knowledgeRoot(workspaceDir), '.uploads')
}

/** Kinds whose text is extracted in the VM (the others are decoded on the host). */
const VM_KINDS = new Set<KnowledgeKind>([
  'pdf',
  'docx',
  'odt',
  'epub',
  'rtf',
  'html',
  'image',
  'pptx',
  'xlsx',
])

export function needsVm(kind: KnowledgeKind): boolean {
  return VM_KINDS.has(kind)
}

const CODE_EXTENSIONS = new Set(
  (
    'ts tsx js jsx mjs cjs py go rs java kt kts swift c h cc cpp hpp cs rb php sh bash zsh sql yaml yml toml ' +
    'ini cfg conf xml css scss less vue svelte lua r scala dart ex exs erl hs clj pl tf gradle dockerfile makefile'
  ).split(' '),
)

function extension(name: string): string {
  const base = name.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase()
}

/** Kind of a text file by its name. */
function textKind(name: string): KnowledgeKind {
  const ext = extension(name)
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (ext === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'json'
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  return 'text'
}

/** What to do with a file: its kind, or why it cannot be indexed. */
export function kindOf(name: string, sniff: FileSniff): { kind: KnowledgeKind } | { unsupported: string } {
  if (sniff.type === 'binary') return { unsupported: sniff.description }
  if (sniff.type === 'text') return { kind: textKind(name) }
  switch (sniff.kind) {
    case 'pdf':
    case 'docx':
    case 'odt':
    case 'epub':
    case 'rtf':
    case 'html':
    case 'xlsx':
    case 'pptx':
    case 'image':
      return { kind: sniff.kind }
    // Read through LibreOffice: stored as the kind of their OOXML twin (the file keeps its name).
    case 'doc':
      return { kind: 'docx' }
    case 'xls':
    case 'ods':
      return { kind: 'xlsx' }
    case 'ppt':
    case 'odp':
      return { kind: 'pptx' }
    case 'csv':
    case 'tsv':
      return { kind: 'csv' }
    case 'markdown':
      return { kind: 'markdown' }
    case 'text':
      return { kind: 'text' }
    default:
      // A ZIP recognized only by the guest (OOXML without a telling name).
      return { kind: 'docx' }
  }
}

/** Guess from the name alone (a VM file not read yet). */
export function kindFromName(name: string): KnowledgeKind {
  const ext = extension(name)
  const byExt: Record<string, KnowledgeKind> = {
    pdf: 'pdf',
    docx: 'docx',
    docm: 'docx',
    odt: 'odt',
    epub: 'epub',
    rtf: 'rtf',
    xlsx: 'xlsx',
    xlsm: 'xlsx',
    pptx: 'pptx',
    pptm: 'pptx',
    doc: 'docx',
    dot: 'docx',
    xls: 'xlsx',
    xlt: 'xlsx',
    ods: 'xlsx',
    ppt: 'pptx',
    pps: 'pptx',
    pot: 'pptx',
    odp: 'pptx',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    tif: 'image',
    tiff: 'image',
    bmp: 'image',
  }
  return byExt[ext] ?? textKind(name)
}

/** A file of the old Office formats (or ODF sheets/slides), by its name: waits for LibreOffice. */
export function isLegacyOfficeName(name: string): boolean {
  return (LEGACY_OFFICE_EXTENSIONS as readonly string[]).includes(extension(name))
}

export function extractKindOf(kind: KnowledgeKind): ExtractKind | undefined {
  switch (kind) {
    case 'pdf':
    case 'docx':
    case 'odt':
    case 'epub':
    case 'rtf':
    case 'html':
    case 'xlsx':
    case 'pptx':
    case 'image':
      return kind
    default:
      return undefined
  }
}

/** `content.md` of an extraction: every page after its `<!-- page N -->` marker (sheet/slide titles as headings). */
export function extractedContent(result: ExtractResult): {
  content: string
  pages: number
  ocrPages: number
} {
  const parts: string[] = []
  let ocrPages = 0
  for (const page of result.pages) {
    if (page.ocr) ocrPages++
    const text = page.text.replace(/\r\n?/g, '\n').replace(/\f/g, '\n').trim()
    const title = page.title?.trim()
    const heading =
      title && !text.startsWith(`# ${title}`) && !text.startsWith(`## ${title}`) ? `## ${title}\n\n` : ''
    parts.push(`<!-- page ${page.n} -->\n${heading}${text}`)
  }
  return {
    content: `${parts.join('\n\n')}\n`,
    pages: result.meta.pageCount || result.pages.length,
    ocrPages,
  }
}

/** Data lines of a CSV (the header excluded). */
export function csvRows(text: string): number {
  const lines = text.split('\n').filter((l) => l.trim()).length
  return Math.max(0, lines - 1)
}

const MIME_BY_KIND: Partial<Record<KnowledgeKind, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  epub: 'application/epub+zip',
  rtf: 'application/rtf',
  html: 'text/html',
  markdown: 'text/markdown',
  text: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  code: 'text/plain',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  note: 'text/markdown',
}

export function mimeOf(kind: KnowledgeKind, given: string): string {
  if (given && given !== 'application/octet-stream') return given
  return MIME_BY_KIND[kind] ?? (given || 'application/octet-stream')
}

/** A file name for a title ("Runbook: deploy" → "Runbook- deploy.md"). */
export function noteFileName(title: string): string {
  const base = [...title]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '-' : c))
    .join('')
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${base || 'document'}.md`
}
