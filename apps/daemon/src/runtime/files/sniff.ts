import type { ExtractKind } from '@milibot/shared'

/**
 * What a file is, from its name and first bytes: text to show as is, a document the VM can turn into text
 * (`/extract`; `kind` undefined = a ZIP the guest recognizes by its central directory), or other binary data.
 */
export type FileSniff =
  { type: 'text' } | { type: 'document'; kind?: ExtractKind } | { type: 'binary'; description: string }

function startsWith(buf: Uint8Array, bytes: number[] | string, offset = 0): boolean {
  const seq = typeof bytes === 'string' ? [...bytes].map((c) => c.charCodeAt(0)) : bytes
  if (buf.length < offset + seq.length) return false
  return seq.every((b, i) => buf[offset + i] === b)
}

function extension(name: string): string {
  const base = name.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

const OOXML_EXTENSIONS: Record<string, ExtractKind> = {
  docx: 'docx',
  docm: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  pptx: 'pptx',
  pptm: 'pptx',
}

/**
 * Word/Excel/PowerPoint 97–2003 and ODF sheets/slides: read through LibreOffice (the `legacyOffice`
 * preference).
 */
export type LegacyOfficeKind = Extract<ExtractKind, 'doc' | 'xls' | 'ppt' | 'ods' | 'odp'>

export function isLegacyOfficeKind(kind: ExtractKind | undefined): kind is LegacyOfficeKind {
  return kind === 'doc' || kind === 'xls' || kind === 'ppt' || kind === 'ods' || kind === 'odp'
}

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

const OLE2_EXTENSIONS: Record<string, LegacyOfficeKind> = {
  doc: 'doc',
  dot: 'doc',
  xls: 'xls',
  xlt: 'xls',
  ppt: 'ppt',
  pps: 'ppt',
  pot: 'ppt',
}

/** Main stream names (UTF-16LE directory entries); the directory is often past the head, so the name counts first. */
const OLE2_STREAMS: Array<[string, LegacyOfficeKind]> = [
  ['WordDocument', 'doc'],
  ['Workbook', 'xls'],
  ['Book', 'xls'],
  ['PowerPoint Document', 'ppt'],
]

function ole2Sniff(name: string, head: Uint8Array): FileSniff {
  const byExtension = OLE2_EXTENSIONS[extension(name)]
  if (byExtension) return { type: 'document', kind: byExtension }
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  const found = OLE2_STREAMS.find(([stream]) => bytes.includes(Buffer.from(`${stream}\0`, 'utf16le')))
  if (found) return { type: 'document', kind: found[1] }
  return {
    type: 'binary',
    description: 'OLE2 compound file (not a recognizable Word, Excel or PowerPoint file)',
  }
}

const BINARY_MAGIC: Array<[number[] | string, string]> = [
  [[0x1f, 0x8b], 'gzip archive'],
  ['7z\xbc\xaf\x27\x1c', '7-Zip archive'],
  ['Rar!', 'RAR archive'],
  [[0x28, 0xb5, 0x2f, 0xfd], 'zstd archive'],
  [[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], 'xz archive'],
  ['BZh', 'bzip2 archive'],
  [[0x7f, 0x45, 0x4c, 0x46], 'ELF executable'],
  [[0xcf, 0xfa, 0xed, 0xfe], 'Mach-O executable'],
  ['MZ', 'Windows executable'],
  ['SQLite format 3\0', 'SQLite database'],
  [[0x00, 0x61, 0x73, 0x6d], 'WebAssembly module'],
  ['OggS', 'Ogg media'],
  ['ID3', 'MP3 audio'],
  ['fLaC', 'FLAC audio'],
]

const SVG_HEAD = /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i

/** Media type of an image a browser can show, from its first bytes; `svg` also recognizes SVG markup. */
export function imageMediaType(buf: Uint8Array, options: { svg?: boolean } = {}): string | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, 'GIF87a') || startsWith(buf, 'GIF89a')) return 'image/gif'
  if (startsWith(buf, 'RIFF') && startsWith(buf, 'WEBP', 8)) return 'image/webp'
  if (startsWith(buf, 'BM') && startsWith(buf, [0, 0, 0, 0], 6)) return 'image/bmp'
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  if (startsWith(buf, 'ftypavif', 4) || startsWith(buf, 'ftypavis', 4)) return 'image/avif'
  if (options.svg && SVG_HEAD.test(Buffer.from(buf.subarray(0, 512)).toString('utf8').trimStart()))
    return 'image/svg+xml'
  return null
}

/** PNG and JPEG: the image types thumbnails are made of and every model provider accepts. */
export function isThumbnailable(
  mediaType: string | null | undefined,
): mediaType is 'image/png' | 'image/jpeg' {
  return mediaType === 'image/png' || mediaType === 'image/jpeg'
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
}

/** Media type of a file by its extension (`application/octet-stream` when unknown). */
export function mimeFromName(name: string): string {
  return MIME_BY_EXTENSION[extension(name)] ?? 'application/octet-stream'
}

function isImage(buf: Uint8Array): boolean {
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

function asciiIncludes(buf: Uint8Array, text: string): boolean {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).includes(text, 0, 'latin1')
}

function zipSniff(name: string, head: Uint8Array): FileSniff {
  if (startsWith(head, 'mimetype', 30)) {
    if (startsWith(head, 'application/epub+zip', 38)) return { type: 'document', kind: 'epub' }
    const odf = 'application/vnd.oasis.opendocument.'
    for (const [type, kind] of [
      ['text', 'odt'],
      ['spreadsheet', 'ods'],
      ['presentation', 'odp'],
    ] as const) {
      if (startsWith(head, odf + type, 38) && !startsWith(head, '-', 38 + odf.length + type.length))
        return { type: 'document', kind }
    }
    return {
      type: 'binary',
      description: 'OpenDocument file that is not a text, spreadsheet or presentation',
    }
  }
  const byExtension = OOXML_EXTENSIONS[extension(name)]
  if (byExtension) return { type: 'document', kind: byExtension }
  if (asciiIncludes(head, 'word/')) return { type: 'document', kind: 'docx' }
  if (asciiIncludes(head, 'xl/')) return { type: 'document', kind: 'xlsx' }
  if (asciiIncludes(head, 'ppt/')) return { type: 'document', kind: 'pptx' }
  if (startsWith(head, '[Content_Types].xml', 30)) return { type: 'document' }
  return { type: 'binary', description: 'ZIP archive' }
}

/** NUL bytes or many control characters in the head; UTF-16 text (with BOM) is text. */
function looksBinary(buf: Uint8Array, sample = 8192): boolean {
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

export function sniffFile(name: string, head: Uint8Array): FileSniff {
  if (startsWith(head, '%PDF-')) return { type: 'document', kind: 'pdf' }
  if (isImage(head)) return { type: 'document', kind: 'image' }
  if (startsWith(head, '{\\rtf')) return { type: 'document', kind: 'rtf' }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return zipSniff(name, head)
  if (startsWith(head, OLE2_MAGIC)) return ole2Sniff(name, head)
  if (!looksBinary(head)) return { type: 'text' }
  if (startsWith(head, 'ustar', 257)) return { type: 'binary', description: 'tar archive' }
  const known = BINARY_MAGIC.find(([magic]) => startsWith(head, magic))
  return { type: 'binary', description: known?.[1] ?? 'binary data' }
}

/** UTF-8 (BOM removed), UTF-16 with BOM, otherwise Latin-1 when the bytes are not valid UTF-8. */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('latin1').decode(buf)
  }
}
