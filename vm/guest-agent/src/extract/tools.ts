import { existsSync, readdirSync } from 'node:fs'

import type { ExtractKind } from '@milibot/shared/portable/guest-api'

import { HttpError } from '../errors.ts'
import { isLegacyOfficeKind, LEGACY_OFFICE_TARGETS } from './kind.ts'

export type ExtractTool =
  'pdftotext' | 'pdftoppm' | 'pdfinfo' | 'pandoc' | 'tesseract' | 'ocrLanguages' | 'python3' | 'soffice'

const BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/bin']
const TESSDATA_ROOTS = ['/usr/share/tesseract-ocr', '/usr/share/tessdata']

export function findBinary(name: string): string | null {
  for (const dir of BIN_DIRS) {
    const candidate = `${dir}/${name}`
    if (existsSync(candidate)) return candidate
  }
  return null
}

function hasOcrLanguages(): boolean {
  const dirs: string[] = []
  for (const root of TESSDATA_ROOTS) {
    if (!existsSync(root)) continue
    dirs.push(root)
    try {
      for (const entry of readdirSync(root)) dirs.push(`${root}/${entry}`, `${root}/${entry}/tessdata`)
    } catch {
      /* unreadable */
    }
  }
  const has = (lang: string) => dirs.some((d) => existsSync(`${d}/${lang}.traineddata`))
  return has('por') && has('eng')
}

function extractToolsStatus(): Record<ExtractTool, boolean> {
  return {
    pdftotext: findBinary('pdftotext') !== null,
    pdftoppm: findBinary('pdftoppm') !== null,
    pdfinfo: findBinary('pdfinfo') !== null,
    pandoc: findBinary('pandoc') !== null,
    tesseract: findBinary('tesseract') !== null,
    ocrLanguages: hasOcrLanguages(),
    python3: findBinary('python3') !== null,
    soffice: findBinary('soffice') !== null,
  }
}

/** Tools a kind needs (a PDF may need OCR for its scanned pages). */
function toolsFor(kind: ExtractKind): ExtractTool[] {
  if (isLegacyOfficeKind(kind)) return ['soffice', ...toolsFor(LEGACY_OFFICE_TARGETS[kind])]
  switch (kind) {
    case 'pdf':
      return ['pdftotext', 'pdftoppm', 'pdfinfo', 'tesseract', 'ocrLanguages']
    case 'image':
      return ['tesseract', 'ocrLanguages']
    case 'docx':
    case 'odt':
    case 'epub':
    case 'rtf':
    case 'html':
      return ['pandoc']
    case 'xlsx':
    case 'pptx':
      return ['python3']
    default:
      return []
  }
}

const toolsMissing = (message: string) => new HttpError(503, 'tools_missing', message)

/** LibreOffice is opt-in per workspace: never installed by an extraction, only by `POST /office/install`. */
const officeMissing = (kind: ExtractKind) =>
  new HttpError(
    503,
    'office_missing',
    `reading .${kind} files needs LibreOffice, which is not installed in the VM`,
  )

export interface ExtractTools {
  /** Throws `office_missing` or `tools_missing` when a tool the kind needs is not installed. */
  ensure(kind: ExtractKind): void
}

export function createExtractTools(
  status: () => Record<ExtractTool, boolean> = extractToolsStatus,
): ExtractTools {
  return {
    ensure(kind) {
      const current = status()
      const missing = toolsFor(kind).filter((tool) => !current[tool])
      if (missing.length === 0) return
      if (missing.includes('soffice')) throw officeMissing(kind)
      throw toolsMissing(`not installed in the VM: ${missing.join(', ')}`)
    },
  }
}
