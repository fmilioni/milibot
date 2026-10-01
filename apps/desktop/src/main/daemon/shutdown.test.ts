import { describe, expect, it } from 'vitest'

import { shutdownDaemon, type ShutdownDeps } from './shutdown'

const target = { pid: 4242, baseUrl: 'http://127.0.0.1:5000', token: 'tok' }

/** A fake daemon that dies `diesAfter` polls after being asked to stop (by route or signal). */
function fakeDaemon(options: { route: 'ok' | 404 | 'down'; diesAfter?: number; platform?: NodeJS.Platform }) {
  let alive = true
  let stopAsked = false
  let polls = 0
  let clock = 0
  const requests: { url: string; method?: string; auth?: string }[] = []
  const signals: string[] = []
  const deps: ShutdownDeps = {
    platform: options.platform ?? 'linux',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
      if (stopAsked && ++polls >= (options.diesAfter ?? 1)) alive = false
    },
    isAlive: () => alive,
    kill: (_pid, signal) => {
      signals.push(signal)
      stopAsked = true
    },
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method,
        auth: (init?.headers as Record<string, string>).authorization,
      })
      if (options.route === 'down') throw new Error('ECONNREFUSED')
      if (options.route === 404) return new Response('', { status: 404 })
      stopAsked = true
      return Response.json({ ok: true })
    }) as typeof fetch,
  }
  return { deps, requests, signals, isAlive: () => alive }
}

describe('shutdownDaemon', () => {
  it('asks the daemon through the authenticated route and waits for it to exit', async () => {
    const daemon = fakeDaemon({ route: 'ok', diesAfter: 3 })
    expect(await shutdownDaemon(target, daemon.deps, 10_000)).toEqual({ stopped: true, method: 'route' })
    expect(daemon.requests).toEqual([
      { url: 'http://127.0.0.1:5000/shutdown', method: 'POST', auth: 'Bearer tok' },
    ])
    expect(daemon.signals).toEqual([])
  })

  it('falls back to SIGTERM on Linux when the route does not exist', async () => {
    for (const route of [404, 'down'] as const) {
      const daemon = fakeDaemon({ route })
      expect(await shutdownDaemon(target, daemon.deps, 10_000)).toEqual({ stopped: true, method: 'signal' })
      expect(daemon.signals).toEqual(['SIGTERM'])
    }
  })

  it('never sends a signal on Windows (it would kill without cleanup)', async () => {
    const daemon = fakeDaemon({ route: 404, platform: 'win32' })
    expect(await shutdownDaemon(target, daemon.deps, 10_000)).toEqual({ stopped: false, method: 'route' })
    expect(daemon.signals).toEqual([])
    expect(daemon.isAlive()).toBe(true)
  })

  it('reports failure when the daemon outlives the timeout, and success when it was not running', async () => {
    const slow = fakeDaemon({ route: 'ok', diesAfter: 1_000 })
    expect((await shutdownDaemon(target, slow.deps, 1_000)).stopped).toBe(false)

    const gone = fakeDaemon({ route: 'ok' })
    gone.deps.isAlive = () => false
    expect(await shutdownDaemon(target, gone.deps, 1_000)).toEqual({ stopped: true, method: 'none' })
  })
})
