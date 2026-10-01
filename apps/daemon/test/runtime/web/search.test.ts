import { describe, expect, it } from 'vitest'

import {
  filterHits,
  formatHits,
  searchBrave,
  type SearchQuery,
  searchTavily,
} from '../../../src/runtime/web/search'

const query = (overrides: Partial<SearchQuery> = {}): SearchQuery => ({
  query: 'tool release',
  count: 8,
  allowedDomains: [],
  blockedDomains: [],
  recency: null,
  language: 'en',
  ...overrides,
})

function jsonFetch(body: unknown, status = 200, seen: Request[] = []): typeof fetch {
  return async (input, init) => {
    seen.push(new Request(input, init))
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

const endpoints = { brave: 'https://brave.test/search', tavily: 'https://tavily.test/search' }

describe('search', () => {
  it('reads Brave results with the key in a header and site operators in the query', async () => {
    const seen: Request[] = []
    const hits = await searchBrave(
      query({ allowedDomains: ['tool.dev'], recency: 'week' }),
      'brave-key-123',
      {
        fetch: jsonFetch(
          {
            web: {
              results: [
                {
                  title: 'Tool <strong>4.2</strong>',
                  url: 'https://tool.dev/?utm_source=x',
                  description: 'New &amp; improved',
                  age: '2 days ago',
                },
              ],
            },
          },
          200,
          seen,
        ),
        endpoints,
        signal: new AbortController().signal,
      },
    )
    expect(hits).toEqual([
      { title: 'Tool 4.2', url: 'https://tool.dev/', snippet: 'New & improved', age: '2 days ago' },
    ])
    const url = new URL(seen[0]!.url)
    expect(url.searchParams.get('q')).toBe('tool release site:tool.dev')
    expect(url.searchParams.get('freshness')).toBe('pw')
    expect(seen[0]!.headers.get('x-subscription-token')).toBe('brave-key-123')
  })

  it('reads Tavily results and turns a rejected key into a clear error without the key', async () => {
    const seen: Request[] = []
    const deps = {
      fetch: jsonFetch({ results: [{ title: 'T', url: 'https://t.dev/', content: 'c' }] }, 200, seen),
      endpoints,
      signal: new AbortController().signal,
    }
    expect(await searchTavily(query({ blockedDomains: ['spam.dev'] }), 'tvly-secret', deps)).toEqual([
      { title: 'T', url: 'https://t.dev/', snippet: 'c' },
    ])
    expect(await seen[0]!.json()).toMatchObject({ query: 'tool release', exclude_domains: ['spam.dev'] })
    const rejected = searchTavily(query(), 'tvly-secret', { ...deps, fetch: jsonFetch({}, 401) })
    await expect(rejected).rejects.toThrow('Tavily rejected the API key (HTTP 401)')
    await expect(rejected).rejects.not.toThrow(/tvly-secret/)
  })

  it('filters domains, drops duplicates and formats a short list', () => {
    const hits = [
      { title: 'A', url: 'https://docs.tool.dev/a', snippet: 's'.repeat(500) },
      { title: 'A again', url: 'https://docs.tool.dev/a/', snippet: '' },
      { title: 'B', url: 'https://other.dev/b', snippet: 'b' },
    ]
    expect(filterHits(hits, query({ allowedDomains: ['tool.dev'] })).map((h) => h.title)).toEqual(['A'])
    expect(filterHits(hits, query({ blockedDomains: ['www.other.dev'] })).map((h) => h.title)).toEqual(['A'])
    const text = formatHits(filterHits(hits, query()), query(), 'Brave Search')
    expect(text.split('\n')).toEqual([
      'Web results for "tool release" (Brave Search):',
      '1. A — https://docs.tool.dev/a',
      `   ${'s'.repeat(199)}…`,
      '2. B — https://other.dev/b',
      '   b',
      'Read a result with web_fetch.',
    ])
    expect(formatHits([], query(), 'Tavily')).toContain('No results')
  })
})
