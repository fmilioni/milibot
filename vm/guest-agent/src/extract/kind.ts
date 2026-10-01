import { EXTRACT_KINDS, type ExtractKind } from '@milibot/shared/portable/guest-api'

import { badRequest } from '../errors.ts'

/** Formats read by converting them with LibreOffice (installed on demand, see `office.ts`) to the OOXML kind. */
export const LEGACY_OFFICE_TARGETS = {
  doc: 'docx',
  xls: 'xlsx',
  ppt: 'pptx',
  ods: 'xlsx',
  odp: 'pptx',
} as const
export type LegacyOfficeKind = keyof typeof LEGACY_OFFICE_TARGETS

export function isLegacyOfficeKind(kind: ExtractKind): kind is LegacyOfficeKind {
  return kind in LEGACY_OFFICE_TARGETS
}

export function parseKind(value: string | null): ExtractKind | null {
  if (value === null || value === '') return null
  if ((EXTRACT_KINDS as readonly string[]).includes(value)) return value as ExtractKind
  throw badRequest(`kind must be one of ${EXTRACT_KINDS.join(', ')}`, 'invalid_kind')
}

const EXTENSION_KINDS: Record<string, ExtractKind> = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  odt: 'odt',
  epub: 'epub',
  rtf: 'rtf',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  pptx: 'pptx',
  pptm: 'pptx',
  doc: 'doc',
  dot: 'doc',
  xls: 'xls',
  xlt: 'xls',
  ppt: 'ppt',
  pps: 'ppt',
  pot: 'ppt',
  ods: 'ods',
  odp: 'odp',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  tif: 'image',
  tiff: 'image',
  bmp: 'image',
  webp: 'image',
  csv: 'csv',
  tsv: 'tsv',
  tab: 'tsv',
  md: 'markdown',
  markdown: 'markdown',
}

export function extensionOf(name: string): string {
  const base = name.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function startsWith(buf: Uint8Array, bytes: number[] | string, offset = 0): boolean {
  const seq = typeof bytes === 'string' ? [...bytes].map((c) => c.charCodeAt(0)) : bytes
  if (buf.length < offset + seq.length) return false
  return seq.every((b, i) => buf[offset + i] === b)
}

function imageMagic(buf: Uint8Array): boolean {
  return (
    startsWith(buf, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(buf, [0xff, 0xd8, 0xff]) ||
    startsWith(buf, 'GIF87a') ||
    startsWith(buf, 'GIF89a') ||
    startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a]) ||
    (startsWith(buf, 'BM') && startsWith(buf, [0, 0, 0, 0], 6)) ||
    (startsWith(buf, 'RIFF') && startsWith(buf, 'WEBP', 8))
  )
}

function includesAscii(buf: Uint8Array, text: string): boolean {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).includes(text, 0, 'latin1')
}

/**
 * ZIP containers: ODF and EPUB store their `mimetype` entry first and uncompressed (its content starts at
 * byte 38); OOXML is recognized by the part names in the central directory.
 */
function zipKind(buf: Uint8Array, ext: string): ExtractKind | null {
  if (startsWith(buf, 'mimetype', 30)) {
    if (startsWith(buf, 'application/epub+zip', 38)) return 'epub'
    const odf = 'application/vnd.oasis.opendocument.'
    for (const [type, kind] of [
      ['text', 'odt'],
      ['spreadsheet', 'ods'],
      ['presentation', 'odp'],
    ] as const) {
      if (startsWith(buf, odf + type, 38) && !startsWith(buf, '-', 38 + odf.length + type.length)) return kind
    }
  }
  const fromExt = EXTENSION_KINDS[ext]
  if (
    fromExt === 'docx' ||
    fromExt === 'xlsx' ||
    fromExt === 'pptx' ||
    fromExt === 'odt' ||
    fromExt === 'epub'
  ) {
    const marker = {
      docx: 'word/',
      xlsx: 'xl/',
      pptx: 'ppt/',
      odt: 'content.xml',
      epub: 'META-INF/container.xml',
    }[fromExt]
    if (includesAscii(buf, marker)) return fromExt
  }
  if (includesAscii(buf, 'word/document.xml')) return 'docx'
  if (includesAscii(buf, 'xl/workbook.xml')) return 'xlsx'
  if (includesAscii(buf, 'ppt/presentation.xml')) return 'pptx'
  return null
}

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** Directory entry names (UTF-16LE, NUL-terminated) of the main stream of each binary Office format. */
const OLE2_STREAMS: Array<[string, LegacyOfficeKind]> = [
  ['WordDocument', 'doc'],
  ['Workbook', 'xls'],
  ['Book', 'xls'],
  ['PowerPoint Document', 'ppt'],
]

/**
 * OLE2 compound files: Word/Excel/PowerPoint 97–2003 by the extension, else by the main stream's name (the
 * directory usually sits at the end, so a head alone may not tell). Other OLE2 files (msg, msi…) are null.
 */
function ole2Kind(buf: Uint8Array, ext: string): LegacyOfficeKind | null {
  const fromExt = EXTENSION_KINDS[ext]
  if (fromExt === 'doc' || fromExt === 'xls' || fromExt === 'ppt') return fromExt
  const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  for (const [name, kind] of OLE2_STREAMS) {
    if (bytes.includes(Buffer.from(`${name}\0`, 'utf16le'))) return kind
  }
  return null
}

/** Share of bytes in the head that no text file has (NUL, most C0 controls). */
export function looksBinary(buf: Uint8Array, sample = 8192): boolean {
  const n = Math.min(buf.length, sample)
  if (n === 0) return false
  if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) return false
  let odd = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]!
    if (b === 0) return true
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b && b !== 0x08) odd++
  }
  return odd / n > 0.1
}

function looksLikeHtml(buf: Uint8Array): boolean {
  const head = Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.byteLength, 1024))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

/**
 * Kind from the magic bytes, then the extension; null = not something we can turn into text (archives,
 * executables…).
 */
export function detectKind(name: string, buf: Uint8Array): ExtractKind | null {
  const ext = extensionOf(name)
  if (startsWith(buf, '%PDF-')) return 'pdf'
  if (imageMagic(buf)) return 'image'
  if (startsWith(buf, '{\\rtf')) return 'rtf'
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return zipKind(buf, ext)
  if (startsWith(buf, OLE2_MAGIC)) return ole2Kind(buf, ext)
  if (looksBinary(buf)) return null
  const fromExt = EXTENSION_KINDS[ext]
  if (fromExt === 'html' || looksLikeHtml(buf)) return 'html'
  if (fromExt === 'csv' || fromExt === 'tsv' || fromExt === 'markdown') return fromExt
  // A text file named like a binary format (e.g. `notes.pdf` that is plain text) is still text.
  return 'text'
}
