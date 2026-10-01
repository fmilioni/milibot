import type {
  ExtractedPage,
  ExtractKind,
  ExtractMeta,
  ExtractResult,
} from '@milibot/shared/portable/guest-api'
import { OCR_LANGUAGES } from '@milibot/shared/portable/guest-constants'

import { HttpError } from '../errors.ts'
import { detectKind, LEGACY_OFFICE_TARGETS } from './kind.ts'
import { OFFICE_SCRIPT, parseOfficeOutput } from './office.ts'
import {
  decodeText,
  needsOcr,
  paginateLines,
  paginateMarkdown,
  PANDOC_TEMPLATE,
  parsePdfInfo,
  splitPandocOutput,
  splitPdfText,
  stripHtmlWrappers,
} from './text.ts'

const MAX_PAGES = 2000
const MAX_OCR_PAGES = 200
const EXTRACT_TIMEOUT_MS = 10 * 60_000
const MAX_TEXT_CHARS = 64 * 1024 * 1024

export interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
  timedOut: boolean
}

/** Runs one command of the extraction (unprivileged, inside the job's folder). */
export interface ExtractRunner {
  run(argv: string[], timeoutMs: number): Promise<RunResult>
}

/** The job's private folder: the input file is already there. */
export interface ExtractWorkdir {
  dir: string
  input: string
  writeFile(name: string, content: string): Promise<string>
  remove(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface ExtractRequest {
  name: string
  kind?: ExtractKind | null
  /** PDF only: page range (1-based, inclusive). */
  first?: number | null
  last?: number | null
}

export interface ExtractEnv {
  runner: ExtractRunner
  workdir: ExtractWorkdir
  now?: () => number
  timeoutMs?: number
  maxOcrPages?: number
  ocrConcurrency?: number
}

const extractFailed = (message: string) => new HttpError(422, 'extract_failed', message)
export const unsupportedFormat = (message: string) => new HttpError(415, 'unsupported_format', message)
const timeoutError = () =>
  new HttpError(504, 'timeout', `extraction took longer than ${EXTRACT_TIMEOUT_MS / 60_000} minutes`)

const PANDOC_FORMATS: Partial<Record<ExtractKind, string>> = {
  docx: 'docx',
  odt: 'odt',
  epub: 'epub',
  rtf: 'rtf',
  html: 'html',
}

function limitPages(pages: ExtractedPage[]): { pages: ExtractedPage[]; truncated: boolean } {
  let truncated = pages.length > MAX_PAGES
  const out: ExtractedPage[] = []
  let chars = 0
  for (const page of pages.slice(0, MAX_PAGES)) {
    chars += page.text.length
    if (chars > MAX_TEXT_CHARS) {
      truncated = true
      break
    }
    out.push(page)
  }
  return { pages: out, truncated }
}

async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) await work(items[next++]!)
  })
  await Promise.all(workers)
}

export async function extractDocument(
  bytes: Uint8Array,
  request: ExtractRequest,
  env: ExtractEnv,
): Promise<ExtractResult> {
  const now = env.now ?? Date.now
  const started = now()
  const deadline = started + (env.timeoutMs ?? EXTRACT_TIMEOUT_MS)
  const kind = request.kind ?? detectKind(request.name, bytes)
  if (!kind)
    throw unsupportedFormat(
      `cannot extract text from ${request.name || 'this file'}: unknown or binary format`,
    )

  const run = async (argv: string[]): Promise<string> => {
    const left = deadline - now()
    if (left <= 0) throw timeoutError()
    const result = await env.runner.run(argv, left)
    if (result.timedOut) throw timeoutError()
    if (result.code !== 0) {
      const detail = result.stderr.trim().split('\n').slice(-6).join('\n')
      throw extractFailed(`${argv[0]} failed (exit ${result.code ?? 'signal'})${detail ? `: ${detail}` : ''}`)
    }
    return result.stdout.toString('utf8')
  }
  const finish = (
    pages: ExtractedPage[],
    meta: Partial<ExtractMeta> & { pageCount?: number },
  ): ExtractResult => {
    const limited = limitPages(pages)
    return {
      kind,
      pages: limited.pages,
      meta: {
        ...(meta.title ? { title: meta.title } : {}),
        pageCount: meta.pageCount ?? pages.length,
        pseudoPages: meta.pseudoPages ?? true,
        ocrSkipped: meta.ocrSkipped ?? [],
        truncated: limited.truncated || meta.truncated === true,
        durationMs: now() - started,
      },
    }
  }
  const ocr = async (image: string): Promise<string> =>
    run(['tesseract', image, 'stdout', '-l', OCR_LANGUAGES])

  const pandoc = async (format: string, file: string): Promise<ExtractResult> => {
    const template = await env.workdir.writeFile('title.tpl', PANDOC_TEMPLATE)
    const out = await run([
      'pandoc',
      '-f',
      format,
      '-t',
      'gfm',
      '--wrap=none',
      '-s',
      `--template=${template}`,
      file,
    ])
    const { title, body } = splitPandocOutput(out)
    return finish(paginateMarkdown(stripHtmlWrappers(body)), { ...(title ? { title } : {}) })
  }
  const officeXml = async (officeKind: 'xlsx' | 'pptx', file: string): Promise<ExtractResult> => {
    const office = parseOfficeOutput(await run(['python3', '-I', '-c', OFFICE_SCRIPT, officeKind, file]))
    return finish(office.pages, {
      ...(office.title ? { title: office.title } : {}),
      pseudoPages: false,
      truncated: office.truncated,
    })
  }

  switch (kind) {
    case 'text':
    case 'csv':
    case 'tsv':
      return finish(paginateLines(decodeText(bytes)), {})
    case 'markdown':
      return finish(paginateMarkdown(decodeText(bytes)), {})
    case 'docx':
    case 'odt':
    case 'epub':
    case 'rtf':
    case 'html':
      return pandoc(PANDOC_FORMATS[kind]!, env.workdir.input)
    case 'xlsx':
    case 'pptx':
      return officeXml(kind, env.workdir.input)
    case 'doc':
    case 'xls':
    case 'ppt':
    case 'ods':
    case 'odp': {
      // Converted to the OOXML twin, then read like one; the profile lives in the job's folder.
      const target = LEGACY_OFFICE_TARGETS[kind]
      const outdir = `${env.workdir.dir}/converted`
      await run([
        'soffice',
        '--headless',
        '--norestore',
        '--nolockcheck',
        `-env:UserInstallation=file://${env.workdir.dir}/lo-profile`,
        '--convert-to',
        target,
        '--outdir',
        outdir,
        env.workdir.input,
      ])
      const base = env.workdir.input
        .split('/')
        .pop()!
        .replace(/\.[^.]*$/, '')
      const converted = `${outdir}/${base}.${target}`
      // soffice exits 0 when it cannot open the file ("source file could not be loaded").
      if (!(await env.workdir.exists(converted))) {
        throw extractFailed(
          `LibreOffice could not open ${request.name || 'the file'} (corrupted or password protected?)`,
        )
      }
      return target === 'docx' ? pandoc('docx', converted) : officeXml(target, converted)
    }
    case 'image': {
      const pages = splitPdfText(await ocr(env.workdir.input)).map((p) => ({ ...p, ocr: true }))
      return finish(pages, { pseudoPages: false })
    }
    case 'pdf': {
      const info = parsePdfInfo(await run(['pdfinfo', env.workdir.input]))
      if (info.pages !== null && (request.first ?? 1) > info.pages) {
        return finish([], {
          ...(info.title ? { title: info.title } : {}),
          pageCount: info.pages,
          pseudoPages: false,
        })
      }
      const total = info.pages ?? MAX_PAGES
      const first = Math.max(1, Math.min(request.first ?? 1, total))
      const wanted = Math.min(request.last ?? total, total)
      const last = Math.max(first, Math.min(wanted, first + MAX_PAGES - 1))
      const text = await run([
        'pdftotext',
        '-layout',
        '-enc',
        'UTF-8',
        '-f',
        String(first),
        '-l',
        String(last),
        env.workdir.input,
        '-',
      ])
      const pages = splitPdfText(text, first)
      const candidates = pages.filter(needsOcr)
      const cap = env.maxOcrPages ?? MAX_OCR_PAGES
      await pool(candidates.slice(0, cap), env.ocrConcurrency ?? 2, async (page) => {
        const prefix = `${env.workdir.dir}/ocr-${page.n}`
        await run([
          'pdftoppm',
          '-r',
          '200',
          '-f',
          String(page.n),
          '-l',
          String(page.n),
          '-png',
          '-singlefile',
          env.workdir.input,
          prefix,
        ])
        try {
          const recognized = splitPdfText(await ocr(`${prefix}.png`))
            .map((p) => p.text)
            .join('\n\n')
          if (recognized.trim()) {
            page.text = recognized
            page.ocr = true
          }
        } finally {
          await env.workdir.remove(`${prefix}.png`)
        }
      })
      return finish(pages, {
        ...(info.title ? { title: info.title } : {}),
        pageCount: info.pages ?? pages.length,
        pseudoPages: false,
        ocrSkipped: candidates.slice(cap).map((p) => p.n),
        truncated: wanted > last,
      })
    }
  }
}
