import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { McpServerConfig } from '@milibot/agent'
import type { Language, LogFn } from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import {
  McpOAuthProvider,
  type McpOAuthRecord,
  type McpOAuthStorage,
  oauthAccount,
  runMcpAuth,
} from './oauth-client'
import type { McpStore } from './store'

const FLOW_TIMEOUT_MS = 10 * 60_000
const CALLBACK_PATH = '/callback'

interface Flow {
  serverId: string
  serverUrl: string
  provider: McpOAuthProvider
  listener: Server
  timer: NodeJS.Timeout
}

export interface McpOAuthDeps {
  store: McpStore
  now: () => number
  fetch?: typeof fetch
  /** A sign-in finished (or failed): reconnect the server and announce it. */
  onChange: (serverId: string) => void
  onConnected: (serverId: string) => Promise<void>
  log: LogFn
  redact: (text: string) => string
}

// Portuguese on purpose: the browser page after a sign-in is shown in the browser's language.
const PAGE_TEXT: Record<Language, { ok: [string, string]; failed: [string, string] }> = {
  'pt-BR': {
    ok: ['Milibot conectado', 'Pode fechar esta aba e voltar ao Milibot.'],
    failed: ['Não deu certo', 'O Milibot não conseguiu concluir a conexão.'],
  },
  en: {
    ok: ['Milibot connected', 'You can close this tab and go back to Milibot.'],
    failed: ['That did not work', 'Milibot could not finish connecting.'],
  },
}

function page(res: ServerResponse, status: number, language: Language, ok: boolean, detail = ''): void {
  const [title, message] = PAGE_TEXT[language][ok ? 'ok' : 'failed']
  const text = [title, detail ? `${message} ${detail}` : message]
  const escape = (value: string) =>
    value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
  const body = `<!doctype html><html lang="${language}"><meta charset="utf-8"><title>Milibot</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f6f4;color:#1c1c1a}
@media(prefers-color-scheme:dark){body{background:#1b1b1a;color:#ededeb}}main{text-align:center;max-width:420px;padding:24px}
h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75;line-height:1.5}</style>
<main><h1>${escape(text[0] as string)}</h1><p>${escape(text[1] as string)}</p></main></html>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function parseRecord(raw: string | null): McpOAuthRecord {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as McpOAuthRecord
  } catch {
    return {}
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/**
 * OAuth sign-in of remote MCP servers: authorization code + PKCE through the system browser,
 * with the redirect caught by a loopback listener on 127.0.0.1 (RFC 8252). The loopback is simpler and
 * sturdier than a `milibot://` scheme: it needs no app registration, works while the daemon runs without
 * a window, and the port the client was registered with is reused when free. Tokens live in the secret store.
 */
export class McpOAuthService {
  private readonly flows = new Map<string, Flow>()
  private readonly records = new Map<string, McpOAuthRecord>()

  constructor(private readonly deps: McpOAuthDeps) {}

  private storage(serverId: string): McpOAuthStorage {
    return {
      load: async () => {
        const cached = this.records.get(serverId)
        if (cached) return cached
        const raw = await this.deps.store.getOAuthRecord(serverId)
        const record = parseRecord(raw)
        this.records.set(serverId, record)
        return record
      },
      save: async (record) => {
        this.records.set(serverId, record)
        await this.deps.store.setOAuthRecord(serverId, JSON.stringify(record))
        const info = this.deps.store.oauthInfo(serverId)
        const hasTokens = Boolean(record.tokens?.access_token)
        if (info && info.hasTokens !== hasTokens)
          this.deps.store.setOAuthInfo(serverId, { ...info, hasTokens })
      },
    }
  }

  /** Background client (manager connections): refreshes tokens, never opens the browser. */
  provider(config: McpServerConfig): McpOAuthProvider {
    return new McpOAuthProvider({
      storage: this.storage(config.id),
      now: this.deps.now,
      fetch: this.deps.fetch,
    })
  }

  authorizing(serverId: string): boolean {
    for (const flow of this.flows.values()) if (flow.serverId === serverId) return true
    return false
  }

  /** The server answered 401 with OAuth metadata: from now on it is an OAuth server. */
  markOAuth(serverId: string): void {
    if (!this.deps.store.oauthInfo(serverId))
      this.deps.store.setOAuthInfo(serverId, { hasTokens: false, account: null, connectedAt: null })
  }

  /** Access and refresh tokens (redaction of logged payloads). */
  async secretValues(serverIds: string[]): Promise<string[]> {
    const values: string[] = []
    for (const id of serverIds) {
      if (!this.deps.store.oauthInfo(id)) continue
      const record = await this.storage(id).load()
      if (record.tokens?.access_token) values.push(record.tokens.access_token)
      if (record.tokens?.refresh_token) values.push(record.tokens.refresh_token)
    }
    return values
  }

  /**
   * Starts a sign-in: returns the authorization URL to open in the browser, or null when the stored
   * refresh token was enough.
   */
  async start(config: McpServerConfig): Promise<string | null> {
    if (config.transport !== 'http' || !config.url)
      throw new DaemonError('validation_failed', 'Only remote servers sign in with OAuth')
    this.cancel(config.id)
    this.markOAuth(config.id)
    const storage = this.storage(config.id)
    const previous = await storage.load()
    const preferredPort = previous.redirectUrl ? Number(new URL(previous.redirectUrl).port) || 0 : 0
    const listener = await listen(preferredPort).catch(() => listen(0))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('unexpected loopback address')
    let authorizationUrl: string | null = null
    const provider = new McpOAuthProvider({
      storage,
      redirectUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url.toString()
      },
      now: this.deps.now,
      fetch: this.deps.fetch,
    })
    try {
      await provider.forgetClientIfRedirectChanged()
      const result = await runMcpAuth(provider, {
        serverUrl: config.url,
        fetch: this.deps.fetch,
      })
      if (result === 'AUTHORIZED' || !authorizationUrl) {
        listener.close()
        await this.finish(config.id)
        return null
      }
    } catch (err) {
      listener.close()
      throw new DaemonError(
        'conflict',
        `Could not start the sign-in: ${this.deps.redact(errorMessage(err))}`,
        {
          reason: 'oauth_start_failed',
        },
      )
    }
    const flow: Flow = {
      serverId: config.id,
      serverUrl: config.url,
      provider,
      listener,
      timer: setTimeout(() => this.cancel(config.id), FLOW_TIMEOUT_MS),
    }
    flow.timer.unref?.()
    this.flows.set(provider.state(), flow)
    listener.on('request', (req, res) => void this.callback(req, res, flow))
    this.deps.onChange(config.id)
    return authorizationUrl
  }

  private async callback(req: IncomingMessage, res: ServerResponse, flow: Flow): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const language: Language = /^pt/i.test(req.headers['accept-language'] ?? '') ? 'pt-BR' : 'en'
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end()
      return
    }
    const state = url.searchParams.get('state')
    if (!state || this.flows.get(state) !== flow) {
      page(res, 400, language, false)
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    try {
      if (error || !code) throw new Error(url.searchParams.get('error_description') ?? error ?? 'no code')
      await runMcpAuth(flow.provider, {
        serverUrl: flow.serverUrl,
        authorizationCode: code,
        fetch: this.deps.fetch,
      })
      page(res, 200, language, true)
      this.end(state)
      await this.finish(flow.serverId)
    } catch (err) {
      const message = this.deps.redact(errorMessage(err))
      this.deps.log('warn', 'mcp oauth sign-in failed', { serverId: flow.serverId, err: message })
      page(res, 400, language, false, message)
      this.end(state)
      this.deps.onChange(flow.serverId)
    }
  }

  private async finish(serverId: string): Promise<void> {
    const record = await this.storage(serverId).load()
    const account = await oauthAccount(record, this.deps.fetch)
    this.deps.store.setOAuthInfo(serverId, {
      hasTokens: Boolean(record.tokens?.access_token),
      account,
      connectedAt: this.deps.now(),
    })
    this.deps.log('info', 'mcp oauth connected', { serverId, account: account !== null })
    await this.deps.onConnected(serverId)
  }

  private end(state: string): void {
    const flow = this.flows.get(state)
    if (!flow) return
    this.flows.delete(state)
    clearTimeout(flow.timer)
    // Frees the port now; the page being sent finishes on its open connection.
    flow.listener.close()
    flow.listener.closeIdleConnections()
  }

  cancel(serverId: string): boolean {
    let cancelled = false
    for (const [state, flow] of this.flows) {
      if (flow.serverId !== serverId) continue
      this.end(state)
      cancelled = true
    }
    if (cancelled) this.deps.onChange(serverId)
    return cancelled
  }

  /** Signs out: forgets the tokens (the client registration is kept for the next sign-in). */
  async disconnect(serverId: string): Promise<void> {
    this.cancel(serverId)
    const storage = this.storage(serverId)
    const record = await storage.load()
    await storage.save({ ...record, tokens: undefined, expiresAt: null })
    this.deps.store.setOAuthInfo(serverId, { hasTokens: false, account: null, connectedAt: null })
  }

  /** The server's URL changed or it was deleted: its sign-in belongs to the old address. */
  async forget(serverId: string): Promise<void> {
    this.cancel(serverId)
    this.records.delete(serverId)
    if (this.deps.store.oauthInfo(serverId)) await this.deps.store.setOAuthRecord(serverId, null)
    this.deps.store.setOAuthInfo(serverId, null)
  }

  close(): void {
    for (const state of [...this.flows.keys()]) this.end(state)
  }
}
