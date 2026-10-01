import { describe, expect, it } from 'vitest'

import { HttpError } from '../src/errors.ts'
import { detectKind, isLegacyOfficeKind, looksBinary, parseKind } from '../src/extract/kind.ts'
import { docxFixture, makeZip, odfFixture, pptxFixture, xlsxFixture } from './zip-fixture.ts'

const bytes = (value: string | number[]) =>
  typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value)

describe('kind detection', () => {
  it('trusts magic bytes over the name', () => {
    expect(detectKind('scan.txt', bytes('%PDF-1.7\n'))).toBe('pdf')
    expect(detectKind('x', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image')
    expect(detectKind('photo', bytes([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image')
    expect(detectKind('a.tif', bytes([0x49, 0x49, 0x2a, 0x00, 8]))).toBe('image')
    expect(detectKind('a', bytes('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe('image')
    expect(detectKind('letter.doc', bytes('{\\rtf1\\ansi hello}'))).toBe('rtf')
  })

  it('tells the ZIP based formats apart', () => {
    expect(detectKind('report.docx', docxFixture())).toBe('docx')
    expect(detectKind('no-extension', docxFixture())).toBe('docx')
    expect(detectKind('sales.xlsx', xlsxFixture())).toBe('xlsx')
    expect(detectKind('deck', pptxFixture())).toBe('pptx')
    expect(detectKind('doc', odfFixture('application/vnd.oasis.opendocument.text'))).toBe('odt')
    expect(detectKind('book', odfFixture('application/epub+zip'))).toBe('epub')
    expect(detectKind('sheet', odfFixture('application/vnd.oasis.opendocument.spreadsheet'))).toBe('ods')
    expect(detectKind('deck', odfFixture('application/vnd.oasis.opendocument.presentation'))).toBe('odp')
    expect(detectKind('t', odfFixture('application/vnd.oasis.opendocument.spreadsheet-template'))).toBeNull()
    expect(detectKind('tpl', odfFixture('application/vnd.oasis.opendocument.text-template'))).toBeNull()
    expect(detectKind('code.zip', makeZip([['src/main.c', 'int main() {}']]))).toBeNull()
  })

  it('decodes text files and refuses other binaries', () => {
    expect(detectKind('data.csv', bytes('a,b\n1,2\n'))).toBe('csv')
    expect(detectKind('data.tsv', bytes('a\tb\n'))).toBe('tsv')
    expect(detectKind('README.md', bytes('# Title\n'))).toBe('markdown')
    expect(detectKind('page', Buffer.from('\uFEFF<!DOCTYPE html><html></html>', 'utf8'))).toBe('html')
    expect(detectKind('main.go', bytes('package main\n'))).toBe('text')
    expect(detectKind('notes.pdf', bytes('actually plain text'))).toBe('text')
    expect(detectKind('a.out', bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0]))).toBeNull()
    expect(looksBinary(bytes([0xff, 0xfe, 0x41, 0x00]))).toBe(false)
    expect(looksBinary(bytes('\x01\x02\x03\x04abc'))).toBe(true)
  })

  it('tells the binary Office formats apart (OLE2)', () => {
    const ole2 = (...streams: string[]) =>
      Buffer.concat([
        bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(1016),
        ...streams.map((n) => Buffer.from(`${n}\0`, 'utf16le')),
      ])
    expect(detectKind('old.doc', ole2())).toBe('doc')
    expect(detectKind('model.DOT', ole2())).toBe('doc')
    expect(detectKind('plan.xls', ole2())).toBe('xls')
    expect(detectKind('show.pps', ole2())).toBe('ppt')
    expect(detectKind('attachment', ole2('Root Entry', 'WordDocument'))).toBe('doc')
    expect(detectKind('attachment', ole2('Root Entry', 'Workbook'))).toBe('xls')
    expect(detectKind('attachment', ole2('Root Entry', 'Book'))).toBe('xls')
    expect(detectKind('attachment', ole2('Root Entry', 'PowerPoint Document'))).toBe('ppt')
    expect(detectKind('mail.msg', ole2('Root Entry', '__substg1.0_0037001F'))).toBeNull()
    expect(detectKind('Bookmarks', ole2('Root Entry', 'Bookmarks'))).toBeNull()
    expect(isLegacyOfficeKind('ppt')).toBe(true)
    expect(isLegacyOfficeKind('pptx')).toBe(false)
  })

  it('validates an explicit kind', () => {
    expect(parseKind('pdf')).toBe('pdf')
    expect(parseKind(null)).toBeNull()
    expect(() => parseKind('exe')).toThrow(HttpError)
  })
})
