import { describe, expect, it } from 'vitest'

import { type HttpError } from '../src/errors.ts'
import { extractDocument, type ExtractEnv, type RunResult } from '../src/extract/extract.ts'
import { PANDOC_BODY_MARKER } from '../src/extract/text.ts'
import { docxFixture } from './zip-fixture.ts'

const bytes = (value: string | number[]) =>
  typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value)

type Handler = (argv: string[]) => Partial<RunResult> | string

function fakeEnv(handler: Handler, extra: Partial<ExtractEnv> = {}, files: string[] = []) {
  const calls: string[][] = []
  const removed: string[] = []
  const written = new Map<string, string>()
  const env: ExtractEnv = {
    runner: {
      async run(argv) {
        calls.push(argv)
        const out = handler(argv)
        const result = typeof out === 'string' ? { stdout: Buffer.from(out) } : out
        return { code: 0, stderr: '', timedOut: false, stdout: Buffer.alloc(0), ...result }
      },
    },
    workdir: {
      dir: '/tmp/job',
      input: '/tmp/job/input.pdf',
      async writeFile(name, content) {
        written.set(name, content)
        return `/tmp/job/${name}`
      },
      async remove(path) {
        removed.push(path)
      },
      async exists(path) {
        return files.includes(path)
      },
    },
    ...extra,
  }
  return { env, calls, removed, written }
}

describe('extractDocument', () => {
  const pdfHandler: Handler = (argv) => {
    if (argv[0] === 'pdfinfo') return 'Title: Contract\nPages: 4\n'
    if (argv[0] === 'pdftotext')
      return 'First page with enough text\f\fThird one also has plenty of text\f   \f'
    if (argv[0] === 'tesseract') return `recognized text from ${argv[1]}\f`
    return ''
  }

  it('OCRs the PDF pages without text and reports it', async () => {
    const { env, calls, removed } = fakeEnv(pdfHandler)
    const result = await extractDocument(bytes('%PDF-1.4'), { name: 'c.pdf' }, env)
    expect(result.kind).toBe('pdf')
    expect(result.pages.map((p) => [p.n, p.ocr])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, true],
    ])
    expect(result.pages[1]!.text).toBe('recognized text from /tmp/job/ocr-2.png')
    expect(result.meta).toMatchObject({
      title: 'Contract',
      pageCount: 4,
      pseudoPages: false,
      ocrSkipped: [],
      truncated: false,
    })
    expect(calls).toContainEqual([
      'pdftotext',
      '-layout',
      '-enc',
      'UTF-8',
      '-f',
      '1',
      '-l',
      '4',
      '/tmp/job/input.pdf',
      '-',
    ])
    expect(calls).toContainEqual([
      'pdftoppm',
      '-r',
      '200',
      '-f',
      '2',
      '-l',
      '2',
      '-png',
      '-singlefile',
      '/tmp/job/input.pdf',
      '/tmp/job/ocr-2',
    ])
    expect(calls).toContainEqual(['tesseract', '/tmp/job/ocr-4.png', 'stdout', '-l', 'por+eng'])
    expect(removed.sort()).toEqual(['/tmp/job/ocr-2.png', '/tmp/job/ocr-4.png'])
  })

  it('caps OCR and honours a page range', async () => {
    const { env, calls } = fakeEnv((argv) => (argv[0] === 'pdftotext' ? '\f\f\f' : pdfHandler(argv)), {
      maxOcrPages: 1,
    })
    const result = await extractDocument(bytes('%PDF-1.4'), { name: 'c.pdf', first: 2, last: 4 }, env)
    expect(calls.find((c) => c[0] === 'pdftotext')?.slice(4, 8)).toEqual(['-f', '2', '-l', '4'])
    expect(result.pages.map((p) => [p.n, p.ocr])).toEqual([
      [2, true],
      [3, false],
      [4, false],
    ])
    expect(result.meta.ocrSkipped).toEqual([3, 4])

    const past = await extractDocument(
      bytes('%PDF-1.4'),
      { name: 'c.pdf', first: 9 },
      fakeEnv(pdfHandler).env,
    )
    expect(past.pages).toEqual([])
    expect(past.meta.pageCount).toBe(4)
  })

  it('converts documents with pandoc into cited sections', async () => {
    const { env, calls, written } = fakeEnv(() => `Manual\n${PANDOC_BODY_MARKER}\n# Installation\n\nStep 1\n`)
    const result = await extractDocument(docxFixture(), { name: 'manual.docx' }, env)
    expect(result.kind).toBe('docx')
    expect(result.meta).toMatchObject({ title: 'Manual', pseudoPages: true, pageCount: 1 })
    expect(result.pages).toEqual([{ n: 1, text: '# Installation\n\nStep 1', ocr: false }])
    expect(calls[0]).toEqual([
      'pandoc',
      '-f',
      'docx',
      '-t',
      'gfm',
      '--wrap=none',
      '-s',
      '--template=/tmp/job/title.tpl',
      '/tmp/job/input.pdf',
    ])
    expect(written.get('title.tpl')).toContain('$body$')
  })

  it('converts old Office files with LibreOffice and reads the OOXML twin', async () => {
    const doc = fakeEnv(() => `Minutes\n${PANDOC_BODY_MARKER}\n# Meeting\n\nAgenda\n`, {}, [
      '/tmp/job/converted/input.docx',
    ])
    const docResult = await extractDocument(
      bytes([0xd0, 0xcf, 0x11, 0xe0]),
      { name: 'minutes.doc', kind: 'doc' },
      doc.env,
    )
    expect(docResult.kind).toBe('doc')
    expect(docResult.meta).toMatchObject({ title: 'Minutes', pseudoPages: true })
    expect(doc.calls[0]).toEqual([
      'soffice',
      '--headless',
      '--norestore',
      '--nolockcheck',
      '-env:UserInstallation=file:///tmp/job/lo-profile',
      '--convert-to',
      'docx',
      '--outdir',
      '/tmp/job/converted',
      '/tmp/job/input.pdf',
    ])
    expect(doc.calls[1]?.slice(0, 3)).toEqual(['pandoc', '-f', 'docx'])
    expect(doc.calls[1]?.at(-1)).toBe('/tmp/job/converted/input.docx')

    const slides = JSON.stringify({
      title: 'Plan',
      truncated: false,
      pages: [{ n: 1, title: 'Goals', text: '18%' }],
    })
    const ppt = fakeEnv((argv) => (argv[0] === 'python3' ? slides : ''), {}, [
      '/tmp/job/converted/input.pptx',
    ])
    const pptResult = await extractDocument(
      bytes([0xd0, 0xcf, 0x11, 0xe0]),
      { name: 'plano.ppt', kind: 'ppt' },
      ppt.env,
    )
    expect(ppt.calls[0]).toContain('pptx')
    expect(ppt.calls[1]?.slice(-2)).toEqual(['pptx', '/tmp/job/converted/input.pptx'])
    expect(pptResult).toMatchObject({ kind: 'ppt', meta: { title: 'Plan', pseudoPages: false } })

    const broken = fakeEnv(() => 'Error: source file could not be loaded')
    await expect(
      extractDocument(bytes([0xd0]), { name: 'x.xls', kind: 'xls' }, broken.env),
    ).rejects.toMatchObject({
      code: 'extract_failed',
    })
    expect(broken.calls).toHaveLength(1)
  })

  it('OCRs images and decodes text without running anything', async () => {
    const image = fakeEnv(() => 'Nota fiscal 123\n\f')
    const result = await extractDocument(bytes([0xff, 0xd8, 0xff, 0xe0]), { name: 'nf.jpg' }, image.env)
    expect(result.pages).toEqual([{ n: 1, text: 'Nota fiscal 123', ocr: true }])

    const text = fakeEnv(() => '')
    const csv = await extractDocument(bytes('a;b\n1;2\n'), { name: 'x.csv' }, text.env)
    expect(csv.kind).toBe('csv')
    expect(csv.pages).toEqual([{ n: 1, text: 'a;b\n1;2', ocr: false }])
    expect(text.calls).toEqual([])
  })

  it('reports errors with codes', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (err: HttpError) => err.code,
      )
    expect(
      await code(extractDocument(bytes([0x7f, 0x45, 0x4c, 0x46, 0]), { name: 'bin' }, fakeEnv(() => '').env)),
    ).toBe('unsupported_format')
    expect(
      await code(
        extractDocument(
          bytes('%PDF-1.4'),
          { name: 'a.pdf' },
          fakeEnv(() => ({ code: 1, stderr: 'Syntax Error' })).env,
        ),
      ),
    ).toBe('extract_failed')
    expect(
      await code(
        extractDocument(
          bytes('%PDF-1.4'),
          { name: 'a.pdf' },
          fakeEnv(() => ({ timedOut: true, code: null })).env,
        ),
      ),
    ).toBe('timeout')
    let t = 0
    const slow = fakeEnv(pdfHandler, { now: () => (t += 400_000), timeoutMs: 600_000 })
    expect(await code(extractDocument(bytes('%PDF-1.4'), { name: 'a.pdf' }, slow.env))).toBe('timeout')
  })
})
