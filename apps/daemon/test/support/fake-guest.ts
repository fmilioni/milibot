import { createHash } from 'node:crypto'

import { solidPng } from '@milibot/agent/testing'
import type { GuestStats } from '@milibot/shared'

import { GuestClient } from '../../src/runtime/vm/guest-client'
import { type FakeGuestProc, procEventsResponse, startFakeProc } from './fake-procs'
import { readTar, writeTar } from './tar'

export interface FakeGuestState {
  healthy: boolean
  provisioned: Array<{ slug: string; uid: number; display: number }>
  /** Desktops `/health` reports as already running. */
  runningDesktops: Array<{ slug: string; uid: number; display: number }>
  removed: Array<{ slug: string; deleteHome?: boolean }>
  inputs: Array<{ display: number; actions: unknown[] }>
  execs: Array<Record<string, unknown>>
  /** `/fs/*`: text, or bytes for binary files. */
  files: Map<string, string | Uint8Array>
  /** `/extract` requests (query + body) and the handler that answers them. */
  extracts: Array<{ query: Record<string, string>; bytes: Uint8Array }>
  extract: (req: { query: Record<string, string>; bytes: Uint8Array }) => unknown
  /** `/office`: an install/removal finishes after `polls` status reads (`fail`: it fails with that message). */
  office: {
    installed: boolean
    running: 'install' | 'remove' | null
    left: number
    polls: number
    fail: string | null
    error: { message: string; op: 'install' | 'remove' } | null
    requests: string[]
  }
  screenshots: number
  /** The next N requests fail like QEMU's hostfwd resetting a concurrent connection. */
  connectResets: number
  resetsServed: number
  provisionDelayMs: number
  provisionedAt: Map<string, number>
  /** `/procs`: real local processes (argv run as is, `user` ignored). */
  procs: Map<string, FakeGuestProc>
  execResult: (body: Record<string, unknown>) => Record<string, unknown>
  /** `agentSha` of `/health`; a root `/exec` that installs a new agent sets it to the bundle's hash. */
  agentSha: string | null
  /** `/limits` requests. */
  limits: Array<{ bots: Array<{ slug: string; uid: number }>; limits: unknown }>
  /** `/workspace` of the archive endpoints: path → content. */
  workspace: Map<string, string>
  /** Excludes of the last archive request. */
  archiveExcludes: string[] | null
  /** Makes the next archive stream break after this many bytes. */
  breakArchiveAfter: number | null
  /** What `/stats` answers (tests move the counters between samples). */
  stats: GuestStats
}

interface GuestRequest {
  url: URL
  init: RequestInit | undefined
  /** The JSON body (`{}` without one). */
  body: Record<string, unknown>
}

type Route = (req: GuestRequest) => Response | Promise<Response>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const rawBody = async (init: RequestInit | undefined) =>
  new Uint8Array(await new Response(init?.body as ConstructorParameters<typeof Response>[0]).arrayBuffer())

function officeRoute(state: FakeGuestState): Route {
  return ({ url }) => {
    const office = state.office
    const path = url.pathname
    const op = path === '/office/install' ? 'install' : path === '/office/remove' ? 'remove' : null
    if (op) {
      office.requests.push(op)
      if (office.running) office.running = op
      else if ((op === 'install') !== office.installed) {
        office.running = op
        office.left = office.polls
        office.error = null
      }
    } else if (office.running && --office.left <= 0) {
      if (office.fail) office.error = { message: office.fail, op: office.running }
      else office.installed = office.running === 'install'
      office.running = null
    }
    const busy = office.running
    return json({
      state: busy
        ? busy === 'install'
          ? 'installing'
          : 'removing'
        : office.error
          ? 'error'
          : office.installed
            ? 'installed'
            : 'absent',
      installed: office.installed,
      phase: busy ? (busy === 'install' ? 'downloading' : 'removing') : null,
      progress: busy ? 1 - office.left / (office.polls + 1) : null,
      error: busy ? null : (office.error?.message ?? null),
      failed: busy ? null : (office.error?.op ?? null),
    })
  }
}

function archiveRoutes(state: FakeGuestState): Record<string, Route> {
  const excluded = (name: string) => state.archiveExcludes?.some((e) => name.split('/').includes(e))
  return {
    '/archive/workspace/estimate': ({ body }) => {
      state.archiveExcludes = body.excludes as string[]
      let bytes = 0
      let entries = 0
      for (const [name, content] of state.workspace)
        if (!excluded(name)) {
          bytes += content.length
          entries++
        }
      return json({ bytes, entries })
    },
    '/archive/workspace': ({ body }) => {
      state.archiveExcludes = body.excludes as string[]
      const tar = writeTar([...state.workspace].filter(([name]) => !excluded(name)))
      const limit = state.breakArchiveAfter
      state.breakArchiveAfter = null
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (limit === null) {
            controller.enqueue(tar)
            controller.close()
          } else {
            controller.enqueue(tar.subarray(0, limit))
            controller.error(new TypeError('terminated'))
          }
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-tar' } })
    },
  }
}

function fsRoutes(state: FakeGuestState): Record<string, Route> {
  return {
    '/fs/write': ({ body }) => {
      state.files.set(String(body.path), String(body.content))
      return json({ path: body.path, size: String(body.content).length })
    },
    '/fs/read': ({ body }) => {
      const content = state.files.get(String(body.path))
      if (content === undefined) return json({ error: { code: 'path_not_found', message: 'nope' } }, 404)
      if (body.encoding !== 'base64') {
        const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
        return json({ path: body.path, size: text.length, content: text, truncated: false })
      }
      const all = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
      const offset = typeof body.offset === 'number' ? body.offset : 0
      const max = typeof body.maxBytes === 'number' ? body.maxBytes : all.length
      const part = all.subarray(offset, offset + max)
      return json({
        path: body.path,
        size: all.length,
        content: part.toString('base64'),
        truncated: offset + part.length < all.length,
      })
    },
  }
}

function procRoutes(state: FakeGuestState): { list: Route; one: Route } {
  return {
    list: ({ init, body }) => {
      if (init?.method === 'POST') {
        const proc = startFakeProc(state.procs, body)
        return json({ id: proc.id, pid: proc.child.pid })
      }
      return json({
        procs: [...state.procs.values()].map((p) => ({ id: p.id, label: p.label, running: p.running })),
      })
    },
    one: ({ url, init, body }) => {
      const [, id, action] = /^\/procs\/([^/]+)\/(events|stdin|signal)$/.exec(url.pathname) as string[]
      const proc = state.procs.get(decodeURIComponent(id as string))
      if (!proc) return json({ error: { code: 'unknown_process', message: 'no such process' } }, 404)
      if (action === 'events')
        return procEventsResponse(proc, Number(url.searchParams.get('since') ?? 0), init?.signal)
      if (!proc.running) return json({ error: { code: 'process_exited', message: 'exited' } }, 409)
      if (action === 'stdin') {
        if (typeof body.data === 'string' && body.data) proc.child.stdin.write(body.data)
        if (body.eof === true) proc.child.stdin.end()
        return json({ ok: true })
      }
      proc.child.kill(String(body.signal) as NodeJS.Signals)
      return json({ ok: true })
    },
  }
}

export type FakeGuest = ReturnType<typeof fakeGuest>

/** A `fetch` that answers like the guest agent (only the endpoints the daemon uses). */
export function fakeGuest(): {
  state: FakeGuestState
  fetch: typeof fetch
  client: (url: string, token: string) => GuestClient
} {
  const state: FakeGuestState = {
    healthy: true,
    provisioned: [],
    runningDesktops: [],
    removed: [],
    inputs: [],
    execs: [],
    files: new Map(),
    extracts: [],
    extract: () => ({ error: { code: 'unsupported_format', message: 'no extractor' }, status: 415 }),
    office: { installed: false, running: null, left: 0, polls: 2, fail: null, error: null, requests: [] },
    screenshots: 0,
    connectResets: 0,
    resetsServed: 0,
    provisionDelayMs: 0,
    provisionedAt: new Map(),
    procs: new Map(),
    agentSha: null,
    limits: [],
    workspace: new Map(),
    archiveExcludes: null,
    breakArchiveAfter: null,
    stats: {
      at: 0,
      uptimeSec: 60,
      cpus: 4,
      loadavg: [0, 0, 0],
      cpu: { totalTicks: 0, idleTicks: 0 },
      memory: { totalBytes: 8 * 2 ** 30, availableBytes: 6 * 2 ** 30, cacheBytes: 2 ** 30 },
      disks: [
        { path: '/', totalBytes: 40 * 2 ** 30, usedBytes: 10 * 2 ** 30 },
        { path: '/data', totalBytes: 60 * 2 ** 30, usedBytes: 20 * 2 ** 30 },
      ],
      bots: [],
    },
    execResult: () => ({
      code: 0,
      signal: null,
      stdout: 'hello\n',
      stderr: '',
      truncated: {},
      timedOut: false,
      durationMs: 3,
    }),
  }
  /** Routes that read the request body as bytes. */
  const rawRoutes: Record<string, (url: URL, init: RequestInit | undefined) => Promise<Response>> = {
    '/extract': async (url, init) => {
      const request = { query: Object.fromEntries(url.searchParams), bytes: await rawBody(init) }
      state.extracts.push(request)
      const out = state.extract(request) as { error?: unknown; status?: number }
      return out.error ? json({ error: out.error }, out.status ?? 422) : json(out)
    },
    '/archive/workspace/extract': async (_url, init) => {
      for (const [name, content] of readTar(await rawBody(init))) state.workspace.set(name, content)
      return json({ ok: true, code: 0, stderr: '' })
    },
  }
  const procs = procRoutes(state)
  const routes: Record<string, Route> = {
    '/office': officeRoute(state),
    '/office/install': officeRoute(state),
    '/office/remove': officeRoute(state),
    '/health': () =>
      state.healthy
        ? json({
            ok: true,
            hostname: 'fake',
            displays: state.runningDesktops.map((d) => ({ ...d, running: true })),
            agentSha: state.agentSha,
          })
        : json({}, 503),
    '/stats': () => json(state.stats),
    '/limits': ({ body }) => {
      state.limits.push(body as FakeGuestState['limits'][number])
      return json({
        results: (body.bots as Array<{ slug: string }>).map((b) => ({ slug: b.slug, ok: true })),
      })
    },
    ...archiveRoutes(state),
    '/bots/provision': async ({ body }) => {
      if (state.provisionDelayMs) await new Promise((r) => setTimeout(r, state.provisionDelayMs))
      state.provisioned.push(body as FakeGuestState['provisioned'][number])
      state.provisionedAt.set(String(body.slug), Date.now())
      return json({
        ...body,
        user: `bot-${String(body.slug)}`,
        vncPort: 5900 + Number(body.display),
        ready: true,
      })
    },
    '/bots/remove': ({ body }) => {
      state.removed.push(body as FakeGuestState['removed'][number])
      state.provisioned = state.provisioned.filter((b) => b.slug !== body.slug)
      return json({ slug: body.slug, removed: true })
    },
    '/exec': ({ body }) => {
      state.execs.push(body)
      if (body.user === 'root' && String(body.cmd).includes('guest-agent.mjs'))
        state.agentSha = createHash('sha256')
          .update(String(body.stdin ?? ''))
          .digest('hex')
          .slice(0, 16)
      return json(state.execResult(body))
    },
    ...fsRoutes(state),
    '/procs': procs.list,
  }
  const patterns: Array<[RegExp, Route]> = [
    [
      /^\/display\/(\d+)\/screenshot$/,
      () => {
        state.screenshots++
        return new Response(solidPng(1280, 800, [30, 30, state.screenshots % 255]), {
          headers: { 'content-type': 'image/png' },
        })
      },
    ],
    [
      /^\/display\/(\d+)\/input$/,
      ({ url, body }) => {
        const display = Number(/^\/display\/(\d+)/.exec(url.pathname)?.[1])
        state.inputs.push({ display, actions: body.actions as unknown[] })
        return json({ ok: true, steps: 1 })
      },
    ],
    [/^\/procs\/[^/]+\/(events|stdin|signal)$/, procs.one],
  ]

  const doFetch: typeof fetch = async (input, init) => {
    if (state.connectResets > 0) {
      state.connectResets--
      state.resetsServed++
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNRESET 127.0.0.1:47400'), {
          code: 'ECONNRESET',
          syscall: 'connect',
        }),
      })
    }
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== 'Bearer fake-token') return json({ error: { code: 'unauthorized', message: 'no' } }, 401)
    const path = url.pathname
    const raw = rawRoutes[path]
    if (raw) return raw(url, init)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    const route = routes[path] ?? patterns.find(([pattern]) => pattern.test(path))?.[1]
    if (!route) return json({ error: { code: 'no_route', message: path } }, 404)
    return route({ url, init, body })
  }
  return {
    state,
    fetch: doFetch,
    client: (url, token) => new GuestClient(url, token, doFetch, { baseDelayMs: 1, maxDelayMs: 5 }),
  }
}
