// OAuth-protected MCP server for tests, built with the SDK's authorization server helpers: metadata
// discovery, dynamic client registration, authorization code + PKCE, refresh tokens, bearer checks.
// `/authorize` approves at once (the test plays the browser by following the redirect).
import { randomUUID } from 'node:crypto'

import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'

import { buildServer } from './mcp-test-server.mjs'

function fakeJwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`
}

export async function startOAuthMcpServer({ accessTtlSec = 3600, account = 'ana@example.com' } = {}) {
  const clients = new Map()
  const codes = new Map()
  const accessTokens = new Map()
  const refreshTokens = new Map()
  const stats = {
    registrations: 0,
    authorizations: 0,
    exchanges: 0,
    refreshes: 0,
    mcpRequests: 0,
    redirectUris: [],
  }
  const now = () => Math.floor(Date.now() / 1000)

  const issue = (clientId) => {
    const access = `at_${randomUUID()}`
    const refresh = `rt_${randomUUID()}`
    accessTokens.set(access, { clientId, expiresAt: now() + accessTtlSec })
    refreshTokens.set(refresh, clientId)
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: accessTtlSec,
      refresh_token: refresh,
      id_token: fakeJwt({ sub: 'u1', email: account }),
    }
  }

  const provider = {
    clientsStore: {
      getClient: (id) => clients.get(id),
      registerClient: (client) => {
        const full = { ...client, client_id: `client_${randomUUID()}`, client_id_issued_at: now() }
        clients.set(full.client_id, full)
        stats.registrations++
        stats.redirectUris.push(...(client.redirect_uris ?? []))
        return full
      },
    },
    async authorize(client, params, res) {
      stats.authorizations++
      const code = `code_${randomUUID()}`
      codes.set(code, { clientId: client.client_id, challenge: params.codeChallenge })
      const target = new URL(params.redirectUri)
      target.searchParams.set('code', code)
      if (params.state) target.searchParams.set('state', params.state)
      res.redirect(302, target.toString())
    },
    async challengeForAuthorizationCode(_client, code) {
      const entry = codes.get(code)
      if (!entry) throw new InvalidGrantError('unknown code')
      return entry.challenge
    },
    async exchangeAuthorizationCode(client, code) {
      const entry = codes.get(code)
      if (!entry || entry.clientId !== client.client_id) throw new InvalidGrantError('unknown code')
      codes.delete(code)
      stats.exchanges++
      return issue(client.client_id)
    },
    async exchangeRefreshToken(client, refreshToken) {
      if (refreshTokens.get(refreshToken) !== client.client_id)
        throw new InvalidGrantError('bad refresh token')
      refreshTokens.delete(refreshToken)
      stats.refreshes++
      return issue(client.client_id)
    },
    async verifyAccessToken(token) {
      const entry = accessTokens.get(token)
      if (!entry || entry.expiresAt <= now()) throw new InvalidTokenError('expired or unknown token')
      return { token, clientId: entry.clientId, scopes: [], expiresAt: entry.expiresAt }
    },
  }

  const app = express()
  const http = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  const base = new URL(`http://127.0.0.1:${http.address().port}`)
  const mcpUrl = new URL('/mcp', base)
  const noLimit = { rateLimit: false }
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: base,
      resourceServerUrl: mcpUrl,
      authorizationOptions: noLimit,
      tokenOptions: noLimit,
      clientRegistrationOptions: noLimit,
      revocationOptions: noLimit,
    }),
  )
  app.post(
    '/mcp',
    requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    }),
    express.json(),
    async (req, res) => {
      stats.mcpRequests++
      const server = buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    },
  )

  return {
    url: mcpUrl.toString(),
    stats,
    /** Expires every access token (the next request gets a 401 and the client refreshes). */
    expireAccessTokens() {
      for (const entry of accessTokens.values()) entry.expiresAt = 0
    },
    /** Invalidates every refresh token (the next refresh fails: the user must sign in again). */
    revokeRefreshTokens() {
      refreshTokens.clear()
    },
    close: () => new Promise((resolve) => http.close(() => resolve())),
  }
}
