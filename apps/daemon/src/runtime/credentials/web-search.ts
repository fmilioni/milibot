import type { WebSearchProvider, WebSearchStatus } from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import type { SecretStore } from '../../secrets/secret-store'
import { DEFAULT_SEARCH_ENDPOINTS, type SearchEndpoints, validateSearchKey } from '../web'
import { maskSecret } from './redaction'

const WEB_SEARCH_KEY = 'web_search.key'
const WEB_SEARCH_SETTING = 'web_search'

interface WebSearchSetting {
  provider: WebSearchProvider
  checkedAt: number
}

export interface WebSearchKeyDeps {
  workspaceId: string
  secrets: SecretStore
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  now: () => number
  fetch: typeof fetch
  endpoints?: SearchEndpoints
}

/** The search API key the daemon calls Brave or Tavily with; never sent to the VM. */
export class WebSearchKey {
  private key: string | null | undefined
  private lastError: string | null = null

  constructor(private readonly deps: WebSearchKeyDeps) {}

  async load(): Promise<string | null> {
    if (this.key === undefined) this.key = await this.deps.secrets.get(this.deps.workspaceId, WEB_SEARCH_KEY)
    return this.key
  }

  /** The loaded key (for redaction), null before `load`. */
  value(): string | null {
    return this.key ?? null
  }

  private setting(): WebSearchSetting | null {
    return this.deps.getSetting<WebSearchSetting | null>(WEB_SEARCH_SETTING, null)
  }

  /** Whether bots get `web_search` (known once the key was loaded). */
  available(): boolean {
    return !!this.key && !!this.setting()
  }

  async current(): Promise<{ provider: WebSearchProvider; key: string } | null> {
    const key = await this.load()
    const setting = this.setting()
    return key && setting ? { provider: setting.provider, key } : null
  }

  /** The outcome of the bots' last search (null = it worked), shown in the settings. */
  report(error: string | null): void {
    this.lastError = error
  }

  async status(): Promise<WebSearchStatus> {
    const current = await this.current()
    return {
      provider: current?.provider ?? null,
      keyPreview: current ? maskSecret(current.key) : null,
      checkedAt: current ? (this.setting()?.checkedAt ?? null) : null,
      lastError: current ? this.lastError : null,
    }
  }

  async set(provider: WebSearchProvider, key: string): Promise<WebSearchStatus> {
    try {
      await validateSearchKey(provider, key, {
        fetch: this.deps.fetch,
        endpoints: this.deps.endpoints ?? DEFAULT_SEARCH_ENDPOINTS,
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      if (err instanceof DaemonError) throw new DaemonError('validation_failed', err.message)
      throw new DaemonError('validation_failed', `Could not check the key: ${errorMessage(err)}`)
    }
    await this.deps.secrets.set(this.deps.workspaceId, WEB_SEARCH_KEY, key)
    this.key = key
    this.lastError = null
    this.deps.setSetting(WEB_SEARCH_SETTING, {
      provider,
      checkedAt: this.deps.now(),
    } satisfies WebSearchSetting)
    return this.status()
  }

  async delete(): Promise<WebSearchStatus> {
    await this.deps.secrets.delete(this.deps.workspaceId, WEB_SEARCH_KEY)
    this.key = null
    this.lastError = null
    this.deps.setSetting(WEB_SEARCH_SETTING, null)
    return this.status()
  }
}
