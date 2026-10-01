import type { ToolExecContext } from '@milibot/agent'
import type { Bot } from '@milibot/shared'
import type { ExtractResult } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { CodeTools } from '../../../src/runtime/code/tools'
import type { LegacyOfficeAccess } from '../../../src/runtime/files/read'
import { sniffFile } from '../../../src/runtime/files/sniff'
import { fakeGuest } from '../../support/fake-guest'

function setup(legacyOffice?: LegacyOfficeAccess) {
  const guest = fakeGuest()
  const client = guest.client('http://guest', 'fake-token')
  const tools = new CodeTools({
    vm: { guest: async () => client },
    ...(legacyOffice ? { legacyOffice: () => legacyOffice } : {}),
  })
  const execute = tools.execute.bind(tools)
  const ctx: ToolExecContext = {
    bot: { id: 'b1', slug: 'ana', displayNum: 4 } as Bot,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  const read = async (args: Record<string, unknown>) => {
    const result = await execute(ctx, { id: 't', name: 'file_read', arguments: args })
    return { text: (result.content[0] as { text: string }).text, isError: result.isError === true }
  }
  return { state: guest.state, read }
}

const bytes = (value: string | number[]) =>
  new Uint8Array(typeof value === 'string' ? Buffer.from(value, 'latin1') : value)

describe('file sniffing', () => {
  it('separates text, extractable documents and other binaries', () => {
    expect(sniffFile('a.ts', bytes('export const x = 1\n'))).toEqual({ type: 'text' })
    expect(sniffFile('a.txt', new Uint8Array(Buffer.from('﻿café', 'utf8')))).toEqual({ type: 'text' })
    expect(sniffFile('x', bytes('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n'))).toEqual({
      type: 'document',
      kind: 'pdf',
    })
    expect(sniffFile('x.png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
      type: 'document',
      kind: 'image',
    })
    expect(sniffFile('BMW.txt', bytes('BMW report\n'))).toEqual({ type: 'text' })
    expect(sniffFile('r.rtf', bytes('{\\rtf1 hi}'))).toEqual({ type: 'document', kind: 'rtf' })
    const zipHead = (first: string, content = '') => bytes(`PK\x03\x04${'\0'.repeat(26)}${first}${content}`)
    expect(sniffFile('report.docx', zipHead('[Content_Types].xml'))).toEqual({
      type: 'document',
      kind: 'docx',
    })
    expect(sniffFile('noext', zipHead('[Content_Types].xml', 'PK..xl/workbook.xml'))).toEqual({
      type: 'document',
      kind: 'xlsx',
    })
    expect(sniffFile('noext', zipHead('[Content_Types].xml'))).toEqual({ type: 'document' })
    expect(sniffFile('a.odt', zipHead('mimetype', 'application/vnd.oasis.opendocument.text'))).toEqual({
      type: 'document',
      kind: 'odt',
    })
    expect(sniffFile('a.ods', zipHead('mimetype', 'application/vnd.oasis.opendocument.spreadsheet'))).toEqual(
      { type: 'document', kind: 'ods' },
    )
    expect(sniffFile('a', zipHead('mimetype', 'application/vnd.oasis.opendocument.presentation'))).toEqual({
      type: 'document',
      kind: 'odp',
    })
    expect(
      sniffFile('a.otg', zipHead('mimetype', 'application/vnd.oasis.opendocument.graphics-template')),
    ).toMatchObject({ type: 'binary' })
    expect(sniffFile('src.zip', zipHead('src/main.c'))).toEqual({
      type: 'binary',
      description: 'ZIP archive',
    })
    expect(sniffFile('a.gz', bytes([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]))).toEqual({
      type: 'binary',
      description: 'gzip archive',
    })
    expect(sniffFile('db', bytes('SQLite format 3\0\x10\0'))).toEqual({
      type: 'binary',
      description: 'SQLite database',
    })
  })
})

const ole2 = (...streams: string[]) =>
  new Uint8Array(
    Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
      ...streams.map((s) => Buffer.from(`${s}\0`, 'utf16le')),
    ]),
  )

describe('old Office files', () => {
  it('are told apart by the extension, then by the main stream name', () => {
    expect(sniffFile('minutes.DOC', ole2())).toEqual({ type: 'document', kind: 'doc' })
    expect(sniffFile('plan.xlt', ole2())).toEqual({ type: 'document', kind: 'xls' })
    expect(sniffFile('show.pps', ole2())).toEqual({ type: 'document', kind: 'ppt' })
    expect(sniffFile('attachment', ole2('Root Entry', 'WordDocument'))).toEqual({
      type: 'document',
      kind: 'doc',
    })
    expect(sniffFile('attachment', ole2('Root Entry', 'Workbook'))).toEqual({ type: 'document', kind: 'xls' })
    expect(sniffFile('attachment', ole2('Root Entry', 'PowerPoint Document'))).toEqual({
      type: 'document',
      kind: 'ppt',
    })
    expect(sniffFile('mail.msg', ole2('Root Entry', '__properties_version1.0'))).toMatchObject({
      type: 'binary',
    })
  })

  it('need "Old Office files" and LibreOffice installed', async () => {
    const off = setup()
    off.state.files.set('/workspace/minutes.doc', ole2())
    const refused = await off.read({ path: 'minutes.doc' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Old Office files')
    expect(off.state.extracts).toEqual([])

    const installing = setup({ enabled: true, installing: true, progress: 0.42 })
    installing.state.files.set('/workspace/minutes.doc', ole2())
    expect((await installing.read({ path: 'minutes.doc' })).text).toContain(
      'being installed in the VM to read it (42%)',
    )
    expect(installing.state.extracts).toEqual([])

    const on = setup({ enabled: true, installing: false, progress: null })
    on.state.files.set('/workspace/minutes.doc', ole2())
    on.state.files.set('/workspace/slides.ppt', ole2())
    on.state.extract = ({ query }): ExtractResult =>
      query.kind === 'doc'
        ? {
            kind: 'doc',
            pages: [{ n: 1, text: '# Minutes\n\nApproved.', ocr: false }],
            meta: { pageCount: 1, pseudoPages: true, ocrSkipped: [], truncated: false, durationMs: 1 },
          }
        : {
            kind: 'ppt',
            pages: [{ n: 1, text: 'Goals', ocr: false, title: 'Plan' }],
            meta: { pageCount: 1, pseudoPages: false, ocrSkipped: [], truncated: false, durationMs: 1 },
          }
    const doc = await on.read({ path: 'minutes.doc' })
    expect(doc.text).toContain('Word 97-2003 document, 1 sections')
    expect(doc.text).toContain('Approved.')
    expect(on.state.extracts[0]!.query).toMatchObject({ name: '/workspace/minutes.doc', kind: 'doc' })
    expect((await on.read({ path: 'slides.ppt' })).text).toContain('--- page 1 · slide "Plan" ---')

    on.state.extract = () => ({ error: { code: 'office_missing', message: 'no soffice' }, status: 503 })
    expect((await on.read({ path: 'minutes.doc' })).text).toContain('LibreOffice is not installed')
  })
})

describe('file_read', () => {
  it('reads text files as numbered lines, decoding Latin-1 when needed', async () => {
    const { state, read } = setup()
    state.files.set('/workspace/notes.txt', 'one\ntwo\nthree\n')
    state.files.set('/workspace/old.txt', bytes([0x61, 0x20, 0x63, 0x61, 0x66, 0xe9]))
    const notes = await read({ path: 'notes.txt', offset: 2, limit: 1 })
    expect(notes.text).toBe('/workspace/notes.txt (4 lines)\n     2\ttwo\n… 2 more lines')
    expect((await read({ path: '/workspace/old.txt' })).text).toContain('1\ta café')
    expect(state.extracts).toEqual([])
  })

  it('reads big text files in chunks', async () => {
    const { state, read } = setup()
    const line = 'x'.repeat(99)
    state.files.set('/workspace/big.log', Array.from({ length: 30_000 }, () => line).join('\n'))
    const out = await read({ path: 'big.log', offset: 29_999, limit: 5 })
    expect(out.text).toContain('/workspace/big.log (30000 lines)')
    expect(out.text).toContain(' 30000\t')
  })

  it('refuses binaries that are not documents', async () => {
    const { state, read } = setup()
    state.files.set('/workspace/app', bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]))
    const out = await read({ path: 'app' })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('binary file (ELF executable)')
    expect(out.text).toContain('bash')
    expect(state.extracts).toEqual([])
  })

  it('extracts PDFs page by page with offset/limit as pages', async () => {
    const { state, read } = setup()
    const pdf = bytes(`%PDF-1.7\n${'\0'.repeat(2_000_000)}`)
    state.files.set('/workspace/docs/contract.pdf', pdf)
    state.extract = ({ query }): ExtractResult => {
      const first = Number(query.first)
      const last = Math.min(Number(query.last), 12)
      return {
        kind: 'pdf',
        pages: Array.from({ length: last - first + 1 }, (_, i) => ({
          n: first + i,
          text: `content of page ${first + i}`,
          ocr: first + i === 4,
        })),
        meta: {
          title: 'Contract',
          pageCount: 12,
          pseudoPages: false,
          ocrSkipped: [],
          truncated: false,
          durationMs: 5,
        },
      }
    }
    const out = await read({ path: 'docs/contract.pdf', offset: 3, limit: 2 })
    expect(out.isError).toBe(false)
    expect(state.extracts).toHaveLength(1)
    expect(state.extracts[0]!.query).toEqual({
      name: '/workspace/docs/contract.pdf',
      kind: 'pdf',
      first: '3',
      last: '4',
    })
    expect(Buffer.from(state.extracts[0]!.bytes).equals(Buffer.from(pdf))).toBe(true)
    expect(out.text).toBe(
      [
        '/workspace/docs/contract.pdf — PDF "Contract", 12 pages; text of page 4 read by OCR, may contain errors',
        '--- page 3 ---\ncontent of page 3',
        '--- page 4 (OCR) ---\ncontent of page 4',
        '[Pages 5–12 not shown: call file_read with offset=5.]',
      ].join('\n'),
    )
  })

  it('labels sheets and sections, and explains extraction errors', async () => {
    const { state, read } = setup()
    const zip = bytes(`PK\x03\x04${'\0'.repeat(26)}[Content_Types].xml`)
    state.files.set('/workspace/sales.xlsx', zip)
    state.extract = (): ExtractResult => ({
      kind: 'xlsx',
      pages: [
        { n: 1, text: 'a\tb', ocr: false, title: 'Summary' },
        { n: 2, text: 'c\td', ocr: false, title: 'Notes' },
      ],
      meta: { pageCount: 2, pseudoPages: false, ocrSkipped: [], truncated: false, durationMs: 1 },
    })
    const sheets = await read({ path: 'sales.xlsx' })
    expect(sheets.text).toContain('Excel spreadsheet, 2 sheets')
    expect(sheets.text).toContain('--- page 1 · sheet "Summary" ---\na\tb')
    expect(sheets.text).not.toContain('not shown')

    state.extract = () => ({
      error: { code: 'tools_missing', message: 'not installed in the VM: pandoc' },
      status: 503,
    })
    const missing = await read({ path: 'sales.xlsx' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('The VM lacks the document tools')

    state.extract = () => ({ error: { code: 'unsupported_format', message: 'nope' }, status: 415 })
    expect((await read({ path: 'sales.xlsx' })).text).toContain('is a binary file')
  })
})
