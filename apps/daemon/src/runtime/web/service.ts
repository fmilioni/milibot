import type { AgentHost, ToolExecContext } from '@milibot/agent'
import { WEB_EXTRACT_SYSTEM_PROMPT, webExtractInput } from '@milibot/agent/prompts'
import {
  type Bot,
  clipLine,
  estimateTokens,
  type ExtractResult,
  type Language,
  type WebSearchProvider,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import { decodeText, sniffFile } from '../files'
import type { ExtractOptions, VmController } from '../vm'
import { htmlToMarkdown, textToMarkdown } from './html-markdown'
import {
  ANSWER_MAX_CHARS,
  CACHE_MAX_CHARS,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  DOC_MAX_PAGES,
  EXTRACT_INPUT_MAX_CHARS,
  EXTRACT_MAX_OUTPUT_TOKENS,
  MAX_CONCURRENT_VM_FETCHES,
  SEARCH_CACHE_TTL_MS,
  SMALL_PAGE_TOKENS,
} from './limits'
import { formatAnswer, formatDocPage, outline, selectRelevant, splitPages, type WebDoc } from './pages'
import {
  DEFAULT_SEARCH_ENDPOINTS,
  filterHits,
  formatHits,
  SEARCH_PROVIDER_LABELS,
  searchBrave,
  type SearchEndpoints,
  type SearchQuery,
  searchTavily,
} from './search'
import { normalizeWebUrl } from './url-policy'
import { fetchInVm, type VmFetchRequest, type VmFetchResult } from './vm-fetch'

export interface WebDeps {
  vm: VmController
  host: Pick<AgentHost, 'writeText'>
  searchKey: () => Promise<{ provider: WebSearchProvider; key: string } | null>
  /** The outcome of a search (null = it worked), for the settings. */
  reportSearch?: (error: string | null) => void
  userLanguage: () => Language
  now: () => number
  fetch?: typeof fetch
  endpoints?: SearchEndpoints
  /** Replaces the download in the VM (tests). */
  vmFetch?: (bot: Bot, request: VmFetchRequest, signal: AbortSignal) => Promise<VmFetchResult>
  /** Replaces the guest's `/extract` (tests). */
  extract?: (bytes: Uint8Array, options: ExtractOptions) => Promise<ExtractResult>
  log?: (level: 'info' | 'warn', message: string, extra?: Record<string, unknown>) => void
}

const NO_SEARCH_KEY =
  'Web search is not set up in this workspace: search in your browser, or ask the user to add a Brave Search ' +
  'or Tavily key in Settings → Credentials.'

/** Document kinds the guest's `/extract` turns into text. */
const DOCUMENT_TYPES =
  /^application\/(pdf|msword|rtf|epub\+zip|vnd\.openxmlformats|vnd\.oasis\.opendocument|vnd\.ms-)/

function decodeBody(body: Buffer, charset: string | null): string {
  if (charset && !/^utf-?8$/i.test(charset)) {
    try {
      return new TextDecoder(charset).decode(body)
    } catch {
      // Unknown label: guessed below.
    }
  }
  return decodeText(body)
}

function fileName(url: string, fallback: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    return last && /\.\w{2,5}$/.test(last) ? decodeURIComponent(last) : fallback
  } catch {
    return fallback
  }
}

/**
 * `web_search` (Brave or Tavily with the workspace key, called from the daemon) and `web_fetch` (downloaded in
 * the VM as the bot, converted here, split in parts or answered by the side model). Converted pages and
 * search results are cached for a few minutes, so paging and asking again never download twice.
 */
export class WebService {
  private readonly docs = new Map<string, WebDoc>()
  private readonly searches = new Map<string, { text: string; at: number }>()
  private running = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly deps: WebDeps) {}

  /** Results of a web search with the workspace key (cached for a few minutes). */
  async search(query: Omit<SearchQuery, 'language'>, signal: AbortSignal): Promise<string> {
    const q: SearchQuery = { ...query, language: this.deps.userLanguage() }
    const credentials = await this.deps.searchKey()
    if (!credentials) throw new DaemonError('validation_failed', NO_SEARCH_KEY)
    const cacheKey = JSON.stringify([credentials.provider, q])
    const cached = this.searches.get(cacheKey)
    if (cached && this.deps.now() - cached.at < SEARCH_CACHE_TTL_MS) return cached.text
    const deps = {
      fetch: this.deps.fetch ?? fetch,
      endpoints: this.deps.endpoints ?? DEFAULT_SEARCH_ENDPOINTS,
      signal,
    }
    let hits
    try {
      hits =
        credentials.provider === 'brave'
          ? await searchBrave(q, credentials.key, deps)
          : await searchTavily(q, credentials.key, deps)
    } catch (err) {
      if (signal.aborted) throw err
      const message = err instanceof DaemonError ? err.message : `Web search failed: ${errorMessage(err)}`
      this.deps.reportSearch?.(message)
      throw new DaemonError('internal', `${message}. Try again later or search in your browser.`)
    }
    this.deps.reportSearch?.(null)
    const text = formatHits(filterHits(hits, q), q, SEARCH_PROVIDER_LABELS[credentials.provider])
    this.searches.set(cacheKey, { text, at: this.deps.now() })
    for (const [key, entry] of this.searches)
      if (this.deps.now() - entry.at >= SEARCH_CACHE_TTL_MS) this.searches.delete(key)
    return text
  }

  /**
   * A page downloaded in the VM as the bot and converted: one of its parts (`page`, else the first), or with
   * a `prompt` and no `page`, the side model's answer about it.
   */
  async read(
    ctx: ToolExecContext,
    request: { url: string; prompt: string | null; page: number | null },
  ): Promise<{ text: string; title: string; url: string }> {
    const { url, httpFallback } = normalizeWebUrl(request.url)
    const doc = await this.loadDoc(ctx, url.href, httpFallback)
    const text =
      !request.prompt || request.page !== null
        ? formatDocPage(doc, request.page ?? 1)
        : await this.answer(ctx, doc, request.prompt)
    return { text, title: doc.title, url: doc.url }
  }

  private async answer(ctx: ToolExecContext, doc: WebDoc, prompt: string): Promise<string> {
    if (doc.pages.length === 1 && estimateTokens(doc.markdown) <= SMALL_PAGE_TOKENS)
      return `${formatDocPage(doc, 1)}\n\n(The page is short, so it is shown whole instead of an extracted answer.)`
    const selected = selectRelevant(doc.markdown, prompt, EXTRACT_INPUT_MAX_CHARS)
    try {
      const { text } = await this.deps.host.writeText({
        botId: ctx.bot.id,
        conversationId: ctx.conversationId,
        turnId: ctx.turnId,
        purpose: 'web_fetch',
        system: WEB_EXTRACT_SYSTEM_PROMPT,
        prompt: webExtractInput({ title: doc.title, url: doc.url, ...selected }, prompt),
        maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
        signal: ctx.signal,
      })
      const answer = text.trim() || 'Not found on this page.'
      return formatAnswer(doc, clipLine(answer, ANSWER_MAX_CHARS, { whitespace: 'trim' }))
    } catch (err) {
      if (ctx.signal.aborted) throw err
      this.log('warn', 'web_fetch extraction failed', { url: doc.url, err: errorMessage(err) })
      return `${formatDocPage(doc, 1)}\n\n(Could not extract an answer: ${errorMessage(err)}. Here is the first part instead.)`
    }
  }

  private cached(url: string): WebDoc | null {
    const doc = this.docs.get(url)
    if (!doc) return null
    if (this.deps.now() - doc.fetchedAt >= CACHE_TTL_MS) {
      this.docs.delete(url)
      return null
    }
    this.docs.delete(url)
    this.docs.set(url, doc)
    return doc
  }

  private remember(doc: WebDoc): void {
    for (const key of new Set([doc.requestedUrl, doc.url])) {
      this.docs.delete(key)
      this.docs.set(key, doc)
    }
    let chars = 0
    for (const entry of new Set(this.docs.values())) chars += entry.markdown.length
    for (const [key, entry] of this.docs) {
      if (this.docs.size <= CACHE_MAX_ENTRIES && chars <= CACHE_MAX_CHARS) break
      this.docs.delete(key)
      if (![...this.docs.values()].includes(entry)) chars -= entry.markdown.length
    }
  }

  private async loadDoc(ctx: ToolExecContext, url: string, httpFallback: boolean): Promise<WebDoc> {
    const cached = this.cached(url)
    if (cached) return cached
    const request: VmFetchRequest = {
      url,
      httpFallback,
      acceptLanguage: this.deps.userLanguage() === 'pt-BR' ? 'pt-BR,pt;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
    }
    const fetched = await this.limited(() =>
      this.deps.vmFetch
        ? this.deps.vmFetch(ctx.bot, request, ctx.signal)
        : this.deps.vm.guest().then((guest) => fetchInVm(guest, ctx.bot, request, ctx.signal)),
    )
    const doc = await this.convert(url, fetched, ctx.signal)
    this.remember(doc)
    return doc
  }

  private async convert(requestedUrl: string, fetched: VmFetchResult, signal: AbortSignal): Promise<WebDoc> {
    const base = {
      requestedUrl,
      url: fetched.url,
      redirects: fetched.redirects,
      status: fetched.status,
      published: null as string | null,
      truncated: fetched.truncated,
      needsJs: false,
      fetchedAt: this.deps.now(),
    }
    const type = fetched.contentType ?? ''
    const head = fetched.body.subarray(0, 4096)
    const sniff = sniffFile(fileName(fetched.url, 'download'), head)
    const looksHtml = /<(!doctype html|html|head|body)\b/i.test(decodeText(head))
    if (/html/.test(type) || (sniff.type === 'text' && !/json|markdown/.test(type) && looksHtml)) {
      const html = htmlToMarkdown(decodeBody(fetched.body, fetched.charset), fetched.url)
      return this.withPages(
        { ...base, kind: 'html', title: html.title, published: html.published, needsJs: html.needsJs },
        html.markdown,
      )
    }
    if (sniff.type === 'document' || DOCUMENT_TYPES.test(type)) {
      if (sniff.type === 'document' && sniff.kind === 'image')
        throw new DaemonError(
          'validation_failed',
          `This URL is an image (${type || 'image'}); download it with bash (curl -o) and look at it with file_read.`,
        )
      return this.extractDoc(base, fetched, sniff.type === 'document' ? sniff.kind : undefined, signal)
    }
    if (sniff.type === 'binary')
      throw new DaemonError(
        'validation_failed',
        `This URL is not a readable page (${type || sniff.description}); download it with bash (curl -o) instead.`,
      )
    const text = textToMarkdown(decodeBody(fetched.body, fetched.charset), type)
    return this.withPages({ ...base, kind: 'text', title: fileName(fetched.url, '') }, text)
  }

  private async extractDoc(
    base: Omit<WebDoc, 'kind' | 'title' | 'markdown' | 'pages' | 'outline'>,
    fetched: VmFetchResult,
    kind: ExtractOptions['kind'],
    signal: AbortSignal,
  ): Promise<WebDoc> {
    const options: ExtractOptions = {
      name: fileName(fetched.url, kind ? `document.${kind}` : 'document'),
      ...(kind ? { kind } : {}),
      pages: { first: 1, last: DOC_MAX_PAGES },
      signal,
    }
    const result = this.deps.extract
      ? await this.deps.extract(fetched.body, options)
      : await (await this.deps.vm.guest()).extract(fetched.body, options)
    const text = result.meta.pseudoPages
      ? result.pages.map((p) => p.text.trim()).join('\n\n')
      : result.pages.map((p) => `--- page ${p.n} ---\n${p.text.trim()}`).join('\n\n')
    const more = result.meta.pageCount > result.pages.length && !result.meta.pseudoPages
    return this.withPages(
      {
        ...base,
        kind: result.kind,
        title: result.meta.title ?? fileName(fetched.url, ''),
        truncated: base.truncated || result.meta.truncated || more,
      },
      text,
    )
  }

  private withPages(doc: Omit<WebDoc, 'markdown' | 'pages' | 'outline'>, markdown: string): WebDoc {
    const pages = splitPages(markdown)
    return { ...doc, markdown, pages, outline: outline(pages) }
  }

  /** At most MAX_CONCURRENT_VM_FETCHES downloads at once through the guest agent. */
  private async limited<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT_VM_FETCHES)
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.running++
    try {
      return await run()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.running--
    }
  }

  private log(level: 'info' | 'warn', message: string, extra?: Record<string, unknown>): void {
    this.deps.log?.(level, message, extra)
  }
}
