import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { GUEST_ROUTES as R, type GuestRoute } from '@milibot/shared/portable/guest-api'

import { estimateWorkspace, extractWorkspaceTar, parseExcludes, streamWorkspaceTar } from './archive.ts'
import { tokenMatches } from './auth.ts'
import { listBots, provisionBot, removeBot, validateDisplay, validateSlug } from './bots.ts'
import { handleInput, handleScreenshot } from './display.ts'
import { badRequest, HttpError, notFound } from './errors.ts'
import { execParams, handleExec } from './exec.ts'
import type { OfficeInstaller } from './extract/libreoffice.ts'
import { handleExtract } from './extract/sandbox.ts'
import type { ExtractTools } from './extract/tools.ts'
import { fsRead, fsWrite } from './fsops.ts'
import { health } from './health.ts'
import { type Json, readJson, send, sendError } from './http.ts'
import { ensureDesktopSlice, handleLimits, removeDesktopSlice } from './limits.ts'
import type { ProcessManager } from './procs.ts'
import { readStats } from './stats.ts'
import { requireUser } from './users.ts'

/** Largest JSON body: `/exec` carries stdin in it. */
const MAX_JSON_BYTES = 64 * 1024 * 1024

export interface AgentDeps {
  /** The bearer token (null while the token file is missing). */
  token: () => string | null
  agentSha: string | null
  procs: ProcessManager
  extractTools: ExtractTools
  office: OfficeInstaller
  maxJsonBytes?: number
}

interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  body(): Promise<Json>
}

export interface Route {
  method: 'GET' | 'POST'
  /** Segments starting with `:` are parameters. */
  path: GuestRoute
  /** Answered without the bearer token. */
  public?: boolean
  /** The JSON reply, or undefined when the handler answered itself (streams, PNG). */
  handle(ctx: RouteContext): unknown
}

export function agentRoutes(deps: AgentDeps): Route[] {
  const { procs, office } = deps
  return [
    { method: 'GET', path: R.ping, public: true, handle: () => ({ ok: true }) },
    { method: 'GET', path: R.health, handle: () => health(deps.agentSha) },
    { method: 'GET', path: R.stats, handle: () => readStats(listBots()) },

    { method: 'GET', path: R.bots, handle: () => ({ bots: listBots() }) },
    {
      method: 'POST',
      path: R.provisionBot,
      handle: async ({ body }) => {
        const input = await body()
        const slug = validateSlug(input.slug)
        await ensureDesktopSlice(slug).catch((err: unknown) =>
          console.error(`desktop slice for ${slug}: ${(err as Error).message}`),
        )
        return provisionBot(input)
      },
    },
    {
      method: 'POST',
      path: R.removeBot,
      handle: async ({ body }) => {
        const removed = await removeBot(await body())
        await removeDesktopSlice(removed.slug)
        return removed
      },
    },
    {
      method: 'POST',
      path: R.limits,
      handle: async ({ body }) => ({ results: await handleLimits(await body()) }),
    },

    {
      method: 'POST',
      path: R.workspaceEstimate,
      handle: async ({ body }) => estimateWorkspace(parseExcludes((await body()).excludes)),
    },
    {
      method: 'POST',
      path: R.workspaceTar,
      handle: async ({ req, res, body }) =>
        streamWorkspaceTar(req, res, parseExcludes((await body()).excludes)),
    },
    { method: 'POST', path: R.workspaceExtract, handle: ({ req }) => extractWorkspaceTar(req) },

    { method: 'GET', path: R.office, handle: () => office.status() },
    { method: 'POST', path: R.officeInstall, handle: () => office.install() },
    { method: 'POST', path: R.officeRemove, handle: () => office.remove() },
    {
      method: 'POST',
      path: R.extract,
      handle: ({ req, url }) => handleExtract(req, url, deps.extractTools),
    },

    {
      method: 'POST',
      path: R.screenshot,
      handle: async ({ req, res, params, body }) =>
        handleScreenshot(req, res, validateDisplay(params.n), await body()),
    },
    {
      method: 'POST',
      path: R.input,
      handle: async ({ params, body }) => handleInput(validateDisplay(params.n), await body()),
    },

    { method: 'POST', path: R.exec, handle: async ({ body }) => handleExec(await body()) },
    { method: 'GET', path: R.procs, handle: () => ({ procs: procs.list() }) },
    {
      method: 'POST',
      path: R.procs,
      handle: async ({ body }) => {
        const input = await body()
        const { user, cwd, spec } = execParams(input)
        return procs.start(spec, {
          cwd,
          user: user.name,
          ...(typeof input.label === 'string' ? { label: input.label } : {}),
        })
      },
    },
    {
      method: 'GET',
      path: R.procEvents,
      handle: ({ req, res, url, params }) => {
        const since = Number(url.searchParams.get('since') ?? 0)
        procs.streamEvents(req, res, params.id!, Number.isFinite(since) ? since : 0)
        return undefined
      },
    },
    {
      method: 'POST',
      path: R.procStdin,
      handle: async ({ params, body }) => {
        const input = await body()
        if (input.data !== undefined && typeof input.data !== 'string')
          throw badRequest('data must be a string', 'invalid_stdin')
        procs.write(params.id!, (input.data as string | undefined) ?? '', input.eof === true)
        return { ok: true }
      },
    },
    {
      method: 'POST',
      path: R.procSignal,
      handle: async ({ params, body }) => {
        procs.signal(params.id!, (await body()).signal)
        return { ok: true }
      },
    },

    { method: 'POST', path: R.fsRead, handle: async ({ body }) => fsRead(await body()) },
    {
      method: 'POST',
      path: R.fsWrite,
      handle: async ({ body }) => {
        const input = await body()
        return fsWrite(input, requireUser(input.owner ?? 'agent'))
      },
    },
  ]
}

function matchPath(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null
  const params: Record<string, string> = {}
  for (const [i, segment] of pattern.entries()) {
    if (segment.startsWith(':')) params[segment.slice(1)] = parts[i]!
    else if (segment !== parts[i]) return null
  }
  return params
}

/** HTTP server of the guest agent: bearer auth on everything but public routes, JSON errors. */
export function createAgentServer(deps: AgentDeps, routes: Route[] = agentRoutes(deps)): Server {
  const table = routes.map((route) => ({ route, pattern: route.path.split('/').filter(Boolean) }))
  const maxJsonBytes = deps.maxJsonBytes ?? MAX_JSON_BYTES

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://guest')
    const method = req.method ?? 'GET'
    const parts = url.pathname.split('/').filter(Boolean)
    let found: { route: Route; params: Record<string, string> } | null = null
    for (const { route, pattern } of table) {
      const params = route.method === method ? matchPath(pattern, parts) : null
      if (params) {
        found = { route, params }
        break
      }
    }
    if (!found?.route.public && !tokenMatches(deps.token(), req.headers.authorization)) {
      throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token')
    }
    if (!found) throw notFound(`no route for ${method} ${url.pathname}`, 'no_route')
    let body: Promise<Json> | null = null
    const result = await found.route.handle({
      req,
      res,
      url,
      params: found.params,
      body: () => (body ??= readJson(req, maxJsonBytes)),
    })
    if (result !== undefined) send(res, 200, result)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => sendError(req, res, err))
  })
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  return server
}
