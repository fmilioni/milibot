import type { AddressInfo } from 'node:net'

import { GUEST_ROUTES, guestPath } from '@milibot/shared/portable/guest-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createOfficeInstaller } from '../src/extract/libreoffice.ts'
import { ProcessManager } from '../src/procs.ts'
import { agentRoutes, createAgentServer } from '../src/routes.ts'

const TOKEN = 'test-token-0123456789abcdef'

const deps = {
  token: () => TOKEN,
  agentSha: 'abc',
  procs: new ProcessManager(),
  extractTools: { ensure: () => undefined },
  office: createOfficeInstaller({
    run: async () => ({ code: 0, output: '' }),
    installed: () => false,
    hasLists: () => true,
  }),
  maxJsonBytes: 64,
}
const server = createAgentServer(deps)
let base = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

async function call(method: string, path: string, init: { token?: string | null; body?: string } = {}) {
  const token = init.token === undefined ? TOKEN : init.token
  const res = await fetch(base + path, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(init.body !== undefined ? { body: init.body } : {}),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('guest agent routes', () => {
  it('answers /ping without a token and refuses everything else', async () => {
    expect(await call('GET', '/ping', { token: null })).toEqual({ status: 200, json: { ok: true } })
    for (const token of [null, 'wrong-token-0123456789abcdef']) {
      const res = await call('GET', '/office', { token })
      expect(res.status).toBe(401)
      expect(res.json).toEqual({
        error: { code: 'unauthorized', message: 'missing or invalid bearer token' },
      })
    }
    expect((await call('GET', '/nowhere', { token: null })).status).toBe(401)
  })

  it('routes by method and path, with parameters', async () => {
    expect(await call('GET', '/office')).toMatchObject({
      status: 200,
      json: { state: 'absent', installed: false },
    })
    const unknown = await call('POST', '/procs/nope/stdin', { body: '{"data":"x"}' })
    expect(unknown).toMatchObject({ status: 404, json: { error: { code: 'unknown_process' } } })
    for (const [method, path] of [
      ['GET', '/nowhere'],
      ['GET', '/exec'],
      ['GET', '/procs/nope'],
      ['POST', '/fs/list'],
    ] as const) {
      expect(await call(method, path)).toMatchObject({ status: 404, json: { error: { code: 'no_route' } } })
    }
  })

  it('validates JSON bodies and their size', async () => {
    expect(await call('POST', '/limits', { body: '[1]' })).toMatchObject({
      status: 400,
      json: { error: { code: 'invalid_json' } },
    })
    expect(await call('POST', '/limits', { body: '{}' })).toMatchObject({
      status: 400,
      json: { error: { code: 'invalid_bots' } },
    })
    expect(await call('POST', '/limits', { body: JSON.stringify({ bots: 'x'.repeat(100) }) })).toMatchObject({
      status: 413,
      json: { error: { code: 'body_too_large' } },
    })
  })

  it('serves exactly the routes of the shared contract', () => {
    const routes = agentRoutes(deps)
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length)
    expect([...new Set(routes.map((r) => r.path))].sort()).toEqual(Object.values(GUEST_ROUTES).sort())
  })

  it('fills route parameters', () => {
    expect(guestPath(GUEST_ROUTES.procStdin, { id: 'a/b c' })).toBe('/procs/a%2Fb%20c/stdin')
    expect(guestPath(GUEST_ROUTES.screenshot, { n: 3 })).toBe('/display/3/screenshot')
    expect(() => guestPath(GUEST_ROUTES.input)).toThrow('missing guest route parameter n')
  })
})
