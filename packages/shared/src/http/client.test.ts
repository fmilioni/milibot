import { describe, expect, it } from 'vitest'

import { createApiClient } from './client'
import { isDaemonHealthy } from './daemon-info'
import { ApiError } from './errors'

const info = { host: '127.0.0.1' as const, port: 1234, token: 't'.repeat(32) }

function clientReturning(response: Response) {
  return createApiClient({ baseUrl: 'http://127.0.0.1:1', token: 't', fetch: async () => response })
}

describe('daemon health', () => {
  it('checks the daemon health with the token', async () => {
    const seen: string[] = []
    const ok = await isDaemonHealthy(info, 1000, async (url, init) => {
      seen.push(`${String(url)} ${(init?.headers as Record<string, string>).authorization}`)
      return new Response('{}', { status: 200 })
    })
    expect(ok).toBe(true)
    expect(seen).toEqual([`http://127.0.0.1:1234/health Bearer ${info.token}`])
    expect(await isDaemonHealthy(info, 1000, async () => new Response('', { status: 401 }))).toBe(false)
    expect(
      await isDaemonHealthy(info, 1000, async () => {
        throw new TypeError('fetch failed')
      }),
    ).toBe(false)
  })
})

describe('api client', () => {
  it('rejects an aborted call with the abort reason instead of a network error', async () => {
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
      fetch: (_, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    })
    const controller = new AbortController()
    const call = client.call('health', { signal: controller.signal })
    controller.abort(new Error('switched workspace'))
    await expect(call).rejects.toThrow('switched workspace')
    const failing = createApiClient({
      baseUrl: 'http://127.0.0.1:1',
      token: 't',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(failing.call('health', {})).rejects.toBeInstanceOf(ApiError)
  })

  it('turns an error body into an ApiError with its code', async () => {
    const body = { error: { code: 'not_found', message: 'No such bot', details: { botId: 'b' } } }
    const call = clientReturning(Response.json(body, { status: 404 })).call('health', {})
    await expect(call).rejects.toMatchObject({ code: 'not_found', status: 404, details: { botId: 'b' } })
  })

  it('turns a non-JSON error body into an ApiError, not a SyntaxError', async () => {
    const call = clientReturning(new Response('<html>Bad Gateway</html>', { status: 502 })).call('health', {})
    await expect(call).rejects.toBeInstanceOf(ApiError)
    await expect(
      clientReturning(new Response('oops', { status: 500 })).call('health', {}),
    ).rejects.toMatchObject({ code: 'internal', status: 500 })
  })
})
