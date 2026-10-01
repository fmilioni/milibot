import { describe, expect, it } from 'vitest'

import {
  decodeText,
  needsOcr,
  paginateLines,
  paginateMarkdown,
  PANDOC_BODY_MARKER,
  parsePdfInfo,
  splitPandocOutput,
  splitPdfText,
  stripHtmlWrappers,
} from '../src/extract/text.ts'

describe('text helpers', () => {
  it('splits pdftotext output on form feeds and numbers pages from the range start', () => {
    const pages = splitPdfText('Page one has enough text   \r\nline\f\f  Third\n\n\n\nend\f', 5)
    expect(pages).toEqual([
      { n: 5, text: 'Page one has enough text\nline', ocr: false },
      { n: 6, text: '', ocr: false },
      { n: 7, text: '  Third\n\nend', ocr: false },
    ])
    expect(pages.map(needsOcr)).toEqual([false, true, true])
  })

  it('reads pdfinfo', () => {
    expect(parsePdfInfo('Title:          Lease agreement\nPages:          12\nEncrypted:      no\n')).toEqual(
      {
        pages: 12,
        title: 'Lease agreement',
        encrypted: false,
      },
    )
    expect(parsePdfInfo('Pages: 0\nEncrypted: yes (print:yes)')).toEqual({ pages: null, encrypted: true })
  })

  it('separates the pandoc title from the body', () => {
    expect(splitPandocOutput(`Annual\n  report\n${PANDOC_BODY_MARKER}\n# Intro\n`)).toEqual({
      title: 'Annual report',
      body: '# Intro\n',
    })
    expect(splitPandocOutput(`${PANDOC_BODY_MARKER}\nbody`)).toEqual({ body: 'body' })
  })

  it('drops the div/span wrappers pandoc leaves, keeping HTML tables and code', () => {
    const md =
      '<div id="ch001.xhtml">\n\n# One\n\n</div>\n<table>\n<tr><td>x</td></tr>\n</table>\n```\n<div>\n```'
    expect(stripHtmlWrappers(md)).toBe('\n# One\n\n<table>\n<tr><td>x</td></tr>\n</table>\n```\n<div>\n```')
  })

  it('cuts markdown into pseudo-pages at headings, never inside code fences', () => {
    const paragraph = (label: string, size: number) => `${label} ${'wording '.repeat(size / 8)}`.trim()
    const md = [
      '# Chapter 1',
      paragraph('a', 1500),
      '## Section 1.1',
      paragraph('b', 1500),
      '```',
      '# not a heading',
      '```',
      '# Chapter 2',
      paragraph('c', 300),
    ].join('\n\n')
    const pages = paginateMarkdown(md)
    expect(pages.map((p) => p.text.split('\n')[0])).toEqual(['# Chapter 1', '## Section 1.1', '# Chapter 2'])
    expect(pages[1]!.text).toContain('# not a heading')
    expect(pages.map((p) => p.n)).toEqual([1, 2, 3])
  })

  it('keeps small sections together and splits huge ones by paragraph', () => {
    expect(paginateMarkdown('# A\n\nx\n\n## B\n\ny')).toEqual([
      { n: 1, text: '# A\n\nx\n\n## B\n\ny', ocr: false },
    ])
    const huge = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'z'.repeat(500)}`).join('\n\n')
    const pages = paginateMarkdown(`# Big\n\n${huge}`)
    expect(pages.length).toBeGreaterThan(3)
    for (const page of pages) expect(page.text.length).toBeLessThanOrEqual(6000)
    expect(
      pages
        .map((p) => p.text)
        .join('\n\n')
        .replace(/\s+/g, ''),
    ).toBe(`# Big\n\n${huge}`.replace(/\s+/g, ''))
  })

  it('pages plain text by whole lines', () => {
    const csv = ['id,name', ...Array.from({ length: 400 }, (_, i) => `${i},name ${i}`)].join('\n')
    const pages = paginateLines(csv, { targetChars: 1000 })
    expect(pages.length).toBeGreaterThan(3)
    expect(pages.every((p) => p.text.length <= 1000)).toBe(true)
    expect(pages.map((p) => p.text).join('\n')).toBe(csv)
    expect(paginateLines('')).toEqual([])
  })

  it('decodes UTF-8, UTF-16 and falls back to Latin-1', () => {
    expect(decodeText(Buffer.from('﻿café', 'utf8'))).toBe('café')
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x63, 0x00, 0x61, 0x00, 0x66, 0x00, 0xe9, 0x00]))).toBe('café')
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
  })
})
