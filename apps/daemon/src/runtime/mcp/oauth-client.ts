import { randomBytes } from 'node:crypto'

import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  refreshAuthorization,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/** What Milibot keeps (in the secret store) for one OAuth-protected MCP server. */
export interface McpOAuthRecord {
  /** From dynamic client registration (or a static client id). */
  clientInformation?: OAuthClientInformationMixed
  /** Loopback redirect URI the client was registered with; its port is reused when free. */
  redirectUrl?: string
  tokens?: OAuthTokens
  /** When the access token expires (epoch ms), from `expires_in` when it was saved. */
  expiresAt?: number | null
  discoveryState?: OAuthDiscoveryState
}

export interface McpOAuthStorage {
  load(): Promise<McpOAuthRecord>
  save(record: McpOAuthRecord): Promise<void>
}

/** The server needs the user to (re)authorize Milibot in the browser. */
export class McpAuthRequiredError extends Error {
  constructor(
    message = 'Sign-in required',
    /** The server was not known to use OAuth: a 401 revealed its authorization server. */
    readonly detected = false,
  ) {
    super(message)
    this.name = 'McpAuthRequiredError'
  }
}

export function isAuthRequired(err: unknown): boolean {
  return err instanceof McpAuthRequiredError || err instanceof UnauthorizedError
}

const REFRESH_MARGIN_MS = 60_000

export interface McpOAuthProviderDeps {
  storage: McpOAuthStorage
  /** Interactive flow only: the loopback URI of this attempt. */
  redirectUrl?: string
  /** Interactive flow only: receives the authorization URL to open in the browser. */
  onAuthorizationUrl?: (url: URL) => void
  clientName?: string
  now?: () => number
  fetch?: FetchLike
}

/**
 * OAuth client of one MCP server for the SDK (authorization code + PKCE, dynamic client registration,
 * metadata discovery, refresh). Without `onAuthorizationUrl` it never starts a browser flow: when the
 * tokens can't be refreshed it fails with `McpAuthRequiredError` (the user must reconnect).
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private record: McpOAuthRecord | null = null
  private verifier: string | null = null
  private readonly stateValue = randomBytes(16).toString('base64url')
  private refreshing: Promise<OAuthTokens | undefined> | null = null
  private readonly now: () => number

  constructor(private readonly deps: McpOAuthProviderDeps) {
    this.now = deps.now ?? Date.now
  }

  get interactive(): boolean {
    return this.deps.onAuthorizationUrl !== undefined
  }

  private async load(): Promise<McpOAuthRecord> {
    this.record ??= await this.deps.storage.load()
    return this.record
  }

  private async update(patch: Partial<McpOAuthRecord>): Promise<void> {
    const next = { ...(await this.load()), ...patch }
    this.record = next
    await this.deps.storage.save(next)
  }

  get redirectUrl(): string {
    return this.deps.redirectUrl ?? this.record?.redirectUrl ?? 'http://127.0.0.1/callback'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.deps.clientName ?? 'Milibot',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    return this.stateValue
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const record = await this.load()
    if (!record.clientInformation && !this.interactive) throw new McpAuthRequiredError()
    return record.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.update({ clientInformation, redirectUrl: this.redirectUrl })
  }

  /** Current tokens, refreshed a minute before they expire (the SDK also refreshes after a 401). */
  async tokens(): Promise<OAuthTokens | undefined> {
    const record = await this.load()
    const tokens = record.tokens
    if (!tokens) return undefined
    const expiring = record.expiresAt != null && record.expiresAt - REFRESH_MARGIN_MS <= this.now()
    if (!expiring || !tokens.refresh_token || !record.clientInformation || !record.discoveryState)
      return tokens
    this.refreshing ??= this.refresh(record).finally(() => {
      this.refreshing = null
    })
    return (await this.refreshing) ?? tokens
  }

  private async refresh(record: McpOAuthRecord): Promise<OAuthTokens | undefined> {
    const state = record.discoveryState as OAuthDiscoveryState
    try {
      const fresh = await refreshAuthorization(state.authorizationServerUrl, {
        ...(state.authorizationServerMetadata ? { metadata: state.authorizationServerMetadata } : {}),
        clientInformation: record.clientInformation as OAuthClientInformationMixed,
        refreshToken: record.tokens?.refresh_token as string,
        ...(state.resourceMetadata?.resource ? { resource: state.resourceMetadata.resource } : {}),
        ...(this.deps.fetch ? { fetchFn: this.deps.fetch } : {}),
      })
      await this.saveTokens(fresh)
      return this.record?.tokens
    } catch {
      // The request goes out with the old token; the 401 path refreshes again or asks to reconnect.
      return undefined
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const previous = (await this.load()).tokens
    await this.update({
      // Servers that don't rotate refresh tokens leave it out of the refresh response.
      tokens: { ...tokens, refresh_token: tokens.refresh_token ?? previous?.refresh_token },
      expiresAt: typeof tokens.expires_in === 'number' ? this.now() + tokens.expires_in * 1000 : null,
    })
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.deps.onAuthorizationUrl) throw new McpAuthRequiredError()
    this.deps.onAuthorizationUrl(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No authorization in progress')
    return this.verifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = null
      return
    }
    const record = { ...(await this.load()) }
    if (scope === 'all' || scope === 'client') delete record.clientInformation
    if (scope === 'all' || scope === 'tokens') {
      delete record.tokens
      delete record.expiresAt
    }
    if (scope === 'all' || scope === 'discovery') delete record.discoveryState
    this.record = record
    await this.deps.storage.save(record)
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.update({ discoveryState: state })
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discoveryState
  }

  /** A client registered for another loopback port must register again (servers match redirect URIs exactly). */
  async forgetClientIfRedirectChanged(): Promise<void> {
    const record = await this.load()
    if (record.clientInformation && record.redirectUrl && record.redirectUrl !== this.redirectUrl)
      await this.invalidateCredentials('client')
  }
}

/** Whether an MCP server that answered 401 publishes OAuth metadata (so it can be signed in to). */
export async function detectOAuth(serverUrl: string, fetchFn?: FetchLike): Promise<boolean> {
  try {
    const info = await discoverOAuthServerInfo(serverUrl, fetchFn ? { fetchFn } : {})
    return Boolean(info.authorizationServerMetadata?.authorization_endpoint)
  } catch {
    return false
  }
}

export type McpAuthResult = 'AUTHORIZED' | 'REDIRECT'

/** Runs the SDK's auth orchestration (discovery, registration, PKCE, code exchange, refresh). */
export function runMcpAuth(
  provider: McpOAuthProvider,
  options: { serverUrl: string; authorizationCode?: string; fetch?: FetchLike },
): Promise<McpAuthResult> {
  return auth(provider, {
    serverUrl: options.serverUrl,
    ...(options.authorizationCode ? { authorizationCode: options.authorizationCode } : {}),
    ...(options.fetch ? { fetchFn: options.fetch } : {}),
  })
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function accountFrom(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null
  for (const key of ['email', 'preferred_username', 'name', 'login', 'username']) {
    const value = claims[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200)
  }
  return null
}

/**
 * Who the user signed in as: the ID token when the server sends one, else the OpenID userinfo endpoint when
 * it has one. Many MCP servers have neither (null).
 */
export async function oauthAccount(
  record: McpOAuthRecord,
  fetchFn: FetchLike = fetch,
): Promise<string | null> {
  const tokens = record.tokens
  if (!tokens) return null
  const fromIdToken = tokens.id_token ? accountFrom(decodeJwtPayload(tokens.id_token)) : null
  if (fromIdToken) return fromIdToken
  const metadata = record.discoveryState?.authorizationServerMetadata as
    { userinfo_endpoint?: unknown } | undefined
  if (typeof metadata?.userinfo_endpoint !== 'string') return null
  try {
    const res = await fetchFn(metadata.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? accountFrom((await res.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}
