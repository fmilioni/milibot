import { describe, expect, it } from 'vitest'

import { chunkContent, contentPages, stripPageMarkers } from '../../../src/runtime/knowledge/chunker'
import { extractedContent } from '../../../src/runtime/knowledge/files'
import { paragraphs } from './fixtures'

describe('chunker', () => {
  it('cuts at pages and headings, keeps offsets into content.md and the heading path', () => {
    const content = [
      '<!-- page 1 -->',
      '# Contract',
      '',
      '## Subject',
      '',
      'The subject of this contract is the lease of the property on A Street.',
      '',
      '<!-- page 2 -->',
      '## Payment',
      '',
      'The rent is due on the 5th of each month and is paid by bank slip.',
    ].join('\n')
    const chunks = chunkContent(content, { targetTokens: 12, maxTokens: 64 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    const payment = chunks.find((c) => c.text.includes('rent is due'))
    expect(payment).toMatchObject({ pageFrom: 2, pageTo: 2, heading: 'Contract › Payment' })
    for (const c of chunks) {
      expect(stripPageMarkers(content.slice(c.charStart, c.charEnd))).toBe(c.text)
      expect(c.text).not.toContain('<!-- page')
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i + 1))
  })

  it('keeps chunks near the target, never above the cap, and overlaps consecutive ones', () => {
    const content = paragraphs('word', 40)
    const chunks = chunkContent(content, { targetTokens: 200, overlapTokens: 30, maxTokens: 300 })
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(300)
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!
      const next = chunks[i]!
      expect(next.charStart).toBeLessThan(prev.charEnd)
      expect(next.charStart).toBeGreaterThan(prev.charStart)
    }
  })

  it('splits a single huge paragraph and a CSV with its header on every chunk', () => {
    const huge = 'x'.repeat(10) + ' ' + Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ')
    for (const c of chunkContent(huge, { targetTokens: 100, maxTokens: 150 }))
      expect(c.tokens).toBeLessThanOrEqual(150)

    const csv = ['name,value', ...Array.from({ length: 200 }, (_, i) => `item${i},${i * 10}`)].join('\n')
    const chunks = chunkContent(csv, { targetTokens: 60, maxTokens: 100, csv: true })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(c.text.split('\n')[0]).toBe('name,value')
      expect(c.text.split('\n').filter((l) => l === 'name,value')).toHaveLength(1)
    }
    const rows = chunks.flatMap((c) => c.text.split('\n').slice(1))
    expect(new Set(rows).size).toBe(200)
  })

  it('never spans two real pages with pageBreaks, so short pages are cited one by one', () => {
    const content = [1, 2, 3, 4]
      .map((n) => `<!-- page ${n} -->\nPage ${n}: short text about topic ${n}.`)
      .join('\n\n')
    const merged = chunkContent(content, { targetTokens: 200, maxTokens: 400 })
    expect(merged).toHaveLength(1)
    expect([merged[0]?.pageFrom, merged[0]?.pageTo]).toEqual([1, 4])
    const paged = chunkContent(content, { targetTokens: 200, maxTokens: 400, pageBreaks: true })
    expect(paged.map((c) => [c.pageFrom, c.pageTo])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ])
    expect(paged[2]?.text).toBe('Page 3: short text about topic 3.')
  })

  it('reads the pages of content.md', () => {
    const { content, pages, ocrPages } = extractedContent({
      kind: 'xlsx',
      pages: [
        { n: 1, text: 'a;b\n1;2', ocr: false, title: 'Sales' },
        { n: 2, text: 'text', ocr: true },
      ],
      meta: { pageCount: 2, pseudoPages: false, ocrSkipped: [], truncated: false, durationMs: 1 },
    })
    expect(pages).toBe(2)
    expect(ocrPages).toBe(1)
    expect(content).toContain('<!-- page 1 -->\n## Sales\n\na;b')
    expect(contentPages(content).map((p) => p.n)).toEqual([1, 2])
    expect(contentPages('no markers').map((p) => p.n)).toEqual([null])
  })
})
