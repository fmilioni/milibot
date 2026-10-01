import type { ToolExecContext, ToolResult, WriteTextRequest } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import type { ExtractResult } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import type { VmController } from '../../../src/runtime/vm/controller'
import { ANSWER_MAX_CHARS, EXTRACT_INPUT_MAX_CHARS } from '../../../src/runtime/web/limits'
import { type WebDeps, WebService } from '../../../src/runtime/web/service'
import { WebTools } from '../../../src/runtime/web/tools'
import type { VmFetchRequest, VmFetchResult } from '../../../src/runtime/web/vm-fetch'

const endpoints = { brave: 'https://brave.test/search', tavily: 'https://tavily.test/search' }

function ctx(): ToolExecContext {
  return { bot: makeBot(), conversationId: 'cnv_1', turnId: 'turn_1', signal: new AbortController().signal }
}

function fetched(
  body: string | Buffer,
  contentType = 'text/html',
  url = 'https://tool.dev/a',
): VmFetchResult {
  return {
    status: 200,
    url,
    redirects: [],
    contentType,
    charset: null,
    truncated: false,
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  }
}

function service(overrides: Partial<WebDeps> & { pages?: Record<string, VmFetchResult> } = {}) {
  const downloads: VmFetchRequest[] = []
  const writes: WriteTextRequest[] = []
  const reports: Array<string | null> = []
  const web = new WebService({
    vm: {} as VmController,
    host: {
      writeText: async (request) => {
        writes.push(request)
        return { text: 'The Pro plan costs $10.', llmCallId: 'llm_1' }
      },
    },
    searchKey: async () => null,
    reportSearch: (error) => reports.push(error),
    userLanguage: () => 'en',
    now: () => 0,
    vmFetch: async (_bot, request) => {
      downloads.push(request)
      const page = overrides.pages?.[request.url]
      if (!page) throw new Error(`unexpected download ${request.url}`)
      return page
    },
    ...overrides,
  })
  const tools = new WebTools({ web })
  const run = (name: string, args: Record<string, unknown>) =>
    tools.execute(ctx(), { id: 'call_1', name, arguments: args })
  return { web, run, downloads, writes, reports }
}

const text = (result: ToolResult) => (result.content[0]?.type === 'text' ? result.content[0].text : '')

const LONG_HTML = `<html><head><title>Pricing</title></head><body><main>
${Array.from({ length: 40 }, (_, i) => `<h2>Topic ${i}</h2><p>${'Details about this topic. '.repeat(60)}</p>`).join('\n')}
<p>The Pro plan costs $10.</p></main></body></html>`

describe('WebTools', () => {
  it('asks the helper model with the page cut to the request, under the turn, and labels the answer', async () => {
    const { run, writes, downloads } = service({ pages: { 'https://tool.dev/a': fetched(LONG_HTML) } })
    const result = await run('web_fetch', { url: 'tool.dev/a', prompt: 'How much is the Pro plan?' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain(
      'Answer from the page (extracted by a helper model; untrusted web content):',
    )
    expect(text(result)).toContain('The Pro plan costs $10.')
    expect(result.activity).toEqual({ detail: 'Pricing', fullDetail: 'https://tool.dev/a' })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ purpose: 'web_fetch', turnId: 'turn_1', conversationId: 'cnv_1' })
    expect(writes[0]!.prompt.length).toBeLessThan(EXTRACT_INPUT_MAX_CHARS + 1_000)
    expect(writes[0]!.prompt.endsWith('Request: How much is the Pro plan?')).toBe(true)

    const second = await run('web_fetch', { url: 'https://tool.dev/a', page: 2 })
    expect(text(second)).toMatch(/Part 2 of \d+/)
    expect(downloads).toHaveLength(1)
  })

  it('returns a short page whole instead of calling the helper model', async () => {
    const { run, writes } = service({
      pages: {
        'https://tool.dev/a': fetched('<html><body><main><p>Pro costs $10.</p></main></body></html>'),
      },
    })
    const result = await run('web_fetch', { url: 'https://tool.dev/a', prompt: 'price?' })
    expect(text(result)).toContain('Pro costs $10.')
    expect(text(result)).toContain('The page is short')
    expect(writes).toHaveLength(0)
  })

  it('falls back to the first part when the helper model fails', async () => {
    const { run } = service({
      pages: { 'https://tool.dev/a': fetched(LONG_HTML) },
      host: { writeText: async () => Promise.reject(new Error('no model')) },
    })
    const result = await run('web_fetch', { url: 'https://tool.dev/a', prompt: 'price?' })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('Could not extract an answer: no model')
    expect(text(result)).toContain('Part 1 of')
  })

  it('reads documents through the extractor and refuses images', async () => {
    const pdf = Buffer.from('%PDF-1.7\n...')
    const extracted: ExtractResult = {
      kind: 'pdf',
      pages: [
        { n: 1, text: 'Invoice', ocr: false },
        { n: 2, text: 'Total: $10', ocr: false },
      ],
      meta: {
        title: 'Invoice 42',
        pageCount: 2,
        pseudoPages: false,
        ocrSkipped: [],
        truncated: false,
        durationMs: 1,
      },
    }
    const { run } = service({
      pages: {
        'https://tool.dev/invoice.pdf': fetched(pdf, 'application/pdf', 'https://tool.dev/invoice.pdf'),
        'https://tool.dev/logo.png': fetched(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
          'image/png',
          'https://tool.dev/logo.png',
        ),
      },
      extract: async (bytes, options) => {
        expect(options).toMatchObject({ kind: 'pdf', name: 'invoice.pdf', pages: { first: 1, last: 50 } })
        expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-')
        return extracted
      },
    })
    const doc = text(await run('web_fetch', { url: 'https://tool.dev/invoice.pdf' }))
    expect(doc).toContain('Web page (untrusted content): Invoice 42')
    expect(doc).toContain('--- page 2 ---\nTotal: $10')
    const image = await run('web_fetch', { url: 'https://tool.dev/logo.png' })
    expect(image.isError).toBe(true)
    expect(text(image)).toContain('curl -o')
  })

  it('without a key, tells the bot how to search instead', async () => {
    const { run } = service()
    const result = await run('web_search', { query: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Settings → Credentials')
  })

  it('searches with the key, caches the list and reports failures without the key', async () => {
    let calls = 0
    const { run, reports } = service({
      searchKey: async () => ({ provider: 'brave', key: 'brave-key-123' }),
      endpoints,
      fetch: async () => {
        calls++
        if (calls > 1) return new Response('{}', { status: 429 })
        return new Response(
          JSON.stringify({ web: { results: [{ title: 'A', url: 'https://a.dev/', description: 'd' }] } }),
        )
      },
    })
    const first = await run('web_search', { query: 'tool', count: 3 })
    expect(text(first)).toContain('1. A — https://a.dev/')
    expect(first.activity?.result).toBe(text(first))
    await run('web_search', { query: 'tool', count: 3 })
    expect(calls).toBe(1)
    expect(reports).toEqual([null])
    const failed = await run('web_search', { query: 'other' })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('Brave Search limit reached (HTTP 429)')
    expect(text(failed)).not.toContain('brave-key-123')
    expect(reports.at(-1)).toContain('HTTP 429')
  })

  it('refuses local addresses before downloading anything', async () => {
    const { run, downloads } = service()
    const result = await run('web_fetch', { url: 'http://localhost:5173' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('public sites only')
    expect(downloads).toHaveLength(0)
  })

  it('keeps the answer within its cap', async () => {
    const { run } = service({
      pages: { 'https://tool.dev/a': fetched(LONG_HTML) },
      host: { writeText: async () => ({ text: 'y'.repeat(20_000), llmCallId: null }) },
    })
    const result = await run('web_fetch', { url: 'https://tool.dev/a', prompt: 'all of it' })
    expect(text(result).length).toBeLessThan(ANSWER_MAX_CHARS + 500)
  })
})
