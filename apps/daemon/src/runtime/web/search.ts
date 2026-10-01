import { clipLine, type Language, type WebSearchProvider } from '@milibot/shared'

import { DaemonError } from '../../errors'
import { cleanLink } from './html-markdown'
import { PROVIDER_TIMEOUT_MS, RESULT_URL_MAX_CHARS, SNIPPET_MAX_CHARS, TITLE_MAX_CHARS } from './limits'

export type WebSearchRecency = 'day' | 'week' | 'month' | 'year'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  age?: string
}

export interface SearchQuery {
  query: string
  count: number
  allowedDomains: string[]
  blockedDomains: string[]
  recency: WebSearchRecency | null
  language: Language
}

export interface SearchEndpoints {
  brave: string
  tavily: string
}

export const DEFAULT_SEARCH_ENDPOINTS: SearchEndpoints = {
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
}

export const SEARCH_PROVIDER_LABELS: Record<WebSearchProvider, string> = {
  brave: 'Brave Search',
  tavily: 'Tavily',
}

export interface SearchDeps {
  fetch: typeof fetch
  endpoints: SearchEndpoints
  signal: AbortSignal
}

function hostMatches(url: string, domains: string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return false
  }
  return domains.some((d) => {
    const domain = d
      .toLowerCase()
      .replace(/^(https?:\/\/)?(www\.)?/, '')
      .replace(/\/.*$/, '')
    return !!domain && (host === domain || host.endsWith(`.${domain}`))
  })
}

/** Domain filters applied to any provider's results (they only partly honor them), duplicates dropped. */
export function filterHits(
  hits: SearchHit[],
  q: Pick<SearchQuery, 'allowedDomains' | 'blockedDomains' | 'count'>,
) {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of hits) {
    const key = hit.url.replace(/\/$/, '')
    if (seen.has(key)) continue
    if (q.allowedDomains.length && !hostMatches(hit.url, q.allowedDomains)) continue
    if (q.blockedDomains.length && hostMatches(hit.url, q.blockedDomains)) continue
    seen.add(key)
    out.push(hit)
    if (out.length >= q.count) break
  }
  return out
}

/** The query with `site:` operators for the domain filters (Brave understands them). */
function queryWithSites(q: SearchQuery): string {
  const allowed = q.allowedDomains.map((d) => `site:${d}`)
  const blocked = q.blockedDomains.map((d) => `-site:${d}`)
  const sites = allowed.length > 1 ? `(${allowed.join(' OR ')})` : (allowed[0] ?? '')
  return [q.query, sites, ...blocked].filter(Boolean).join(' ')
}

const BRAVE_RECENCY: Record<WebSearchRecency, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }

function timeout(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)])
}

function stripTags(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/<[^>]+>/g, '')
        .replace(
          /&(amp|lt|gt|quot|#39);/g,
          (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e] ?? '',
        )
    : ''
}

async function providerError(provider: WebSearchProvider, res: Response): Promise<DaemonError> {
  await res.body?.cancel().catch(() => undefined)
  const label = SEARCH_PROVIDER_LABELS[provider]
  if (res.status === 401 || res.status === 403)
    return new DaemonError('validation_failed', `${label} rejected the API key (HTTP ${res.status})`)
  if (res.status === 429) return new DaemonError('validation_failed', `${label} limit reached (HTTP 429)`)
  return new DaemonError('internal', `${label} answered HTTP ${res.status}`)
}

export async function searchBrave(q: SearchQuery, key: string, deps: SearchDeps): Promise<SearchHit[]> {
  const url = new URL(deps.endpoints.brave)
  url.searchParams.set('q', queryWithSites(q))
  url.searchParams.set('count', String(Math.min(20, q.count + 4)))
  if (q.recency) url.searchParams.set('freshness', BRAVE_RECENCY[q.recency])
  if (q.language === 'pt-BR') url.searchParams.set('search_lang', 'pt-br')
  const res = await deps.fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: timeout(deps.signal),
  })
  if (!res.ok) throw await providerError('brave', res)
  const body = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } }
  return (body.web?.results ?? []).flatMap((r) => {
    const link = cleanLink(String(r.url ?? ''), 'https://example.com/')
    if (!link) return []
    const age = typeof r.age === 'string' ? r.age : undefined
    return [
      { title: stripTags(r.title), url: link, snippet: stripTags(r.description), ...(age ? { age } : {}) },
    ]
  })
}

export async function searchTavily(q: SearchQuery, key: string, deps: SearchDeps): Promise<SearchHit[]> {
  const res = await deps.fetch(deps.endpoints.tavily, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: q.query,
      max_results: Math.min(20, q.count + 2),
      search_depth: 'basic',
      ...(q.allowedDomains.length ? { include_domains: q.allowedDomains } : {}),
      ...(q.blockedDomains.length ? { exclude_domains: q.blockedDomains } : {}),
      ...(q.recency ? { time_range: q.recency } : {}),
    }),
    signal: timeout(deps.signal),
  })
  if (!res.ok) throw await providerError('tavily', res)
  const body = (await res.json()) as { results?: Array<Record<string, unknown>> }
  return (body.results ?? []).flatMap((r) => {
    const link = cleanLink(String(r.url ?? ''), 'https://example.com/')
    if (!link) return []
    const age = typeof r.published_date === 'string' ? r.published_date : undefined
    return [
      { title: String(r.title ?? ''), url: link, snippet: String(r.content ?? ''), ...(age ? { age } : {}) },
    ]
  })
}

/** One test query: a key the provider rejects fails here instead of on the bot's first search. */
export async function validateSearchKey(
  provider: WebSearchProvider,
  key: string,
  deps: SearchDeps,
): Promise<void> {
  const q: SearchQuery = {
    query: 'milibot',
    count: 1,
    allowedDomains: [],
    blockedDomains: [],
    recency: null,
    language: 'en',
  }
  if (provider === 'brave') await searchBrave(q, key, deps)
  else await searchTavily(q, key, deps)
}

/** The list the bot reads: numbered, one line of title and URL, one of snippet. */
export function formatHits(hits: SearchHit[], q: SearchQuery, providerLabel: string, note?: string): string {
  const lines = [`Web results for "${clipLine(q.query, 120)}" (${providerLabel}):`]
  if (note) lines.push(note)
  if (!hits.length) {
    lines.push('No results. Try other words, fewer filters or a broader query.')
    return lines.join('\n')
  }
  hits.forEach((hit, i) => {
    const title = clipLine(hit.title || hit.url, TITLE_MAX_CHARS)
    const url =
      hit.url.length > RESULT_URL_MAX_CHARS ? `${hit.url.slice(0, RESULT_URL_MAX_CHARS - 1)}…` : hit.url
    lines.push(`${i + 1}. ${title} — ${url}`)
    const snippet = clipLine(hit.snippet, SNIPPET_MAX_CHARS)
    if (snippet || hit.age) lines.push(`   ${[hit.age, snippet].filter(Boolean).join(' · ')}`)
  })
  lines.push('Read a result with web_fetch.')
  return lines.join('\n')
}
