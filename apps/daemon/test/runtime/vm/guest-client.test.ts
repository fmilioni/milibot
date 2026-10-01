import { describe, expect, it } from 'vitest'

import { classifyNetworkError, GuestClient, GuestError } from '../../../src/runtime/vm/guest-client'

const connectReset = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNRESET 127.0.0.1:47000'), {
      code: 'ECONNRESET',
      syscall: 'connect',
    }),
  })
const socketClosed = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  })

/** Fails the first `failures` requests with `error`, then answers `{ok:true}`. */
function flaky(failures: number, error: () => Error) {
  const calls: string[] = []
  const doFetch: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
    if (calls.length <= failures) throw error()
    return new Response(JSON.stringify({ ok: true, code: 0, stdout: '', stderr: '' }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  const client = new GuestClient('http://127.0.0.1:47000', 'tok', doFetch, { baseDelayMs: 1, maxDelayMs: 5 })
  return { client, calls }
}

describe('GuestClient transient network failures', () => {
  it('classifies connection failures', () => {
    expect(classifyNetworkError(connectReset())).toBe('connect')
    expect(
      classifyNetworkError(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }),
      ),
    ).toBe('connect')
    expect(classifyNetworkError(socketClosed())).toBe('socket')
    expect(classifyNetworkError(new Error('boom'))).toBeNull()
  })

  it('retries any request whose connection was reset before it was sent', async () => {
    const { client, calls } = flaky(3, connectReset)
    await expect(client.exec({ cmd: 'true' })).resolves.toMatchObject({ code: 0 })
    expect(calls).toEqual(['POST /exec', 'POST /exec', 'POST /exec', 'POST /exec'])
  })

  it('retries idempotent requests after a mid-request socket error', async () => {
    const { client, calls } = flaky(2, socketClosed)
    await expect(client.provisionBot({ slug: 'iris', uid: 2002, display: 2 })).resolves.toMatchObject({
      ok: true,
    })
    expect(calls).toHaveLength(3)
  })

  it('does not resend non-idempotent requests after a mid-request socket error', async () => {
    const { client, calls } = flaky(1, socketClosed)
    const err = await client.exec({ cmd: 'rm -rf build' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GuestError)
    expect((err as GuestError).code).toBe('unreachable')
    expect((err as GuestError).message).toContain('other side closed')
    expect(calls).toHaveLength(1)
  })

  it('gives up after the retry budget', async () => {
    const { client, calls } = flaky(100, connectReset)
    await expect(client.exec({ cmd: 'true' })).rejects.toThrow(/guest agent unreachable.*ECONNRESET/)
    expect(calls).toHaveLength(7)
  })

  it('does not retry health polls', async () => {
    const { client, calls } = flaky(1, connectReset)
    await expect(client.health()).rejects.toBeInstanceOf(GuestError)
    expect(calls).toHaveLength(1)
  })

  it('stops retrying when the caller aborts', async () => {
    const abort = new AbortController()
    const calls: string[] = []
    const client = new GuestClient(
      'http://127.0.0.1:47000',
      'tok',
      async () => {
        calls.push('x')
        abort.abort(new Error('stopped'))
        throw connectReset()
      },
      { baseDelayMs: 1 },
    )
    await expect(client.input(1, [{ type: 'click', x: 1, y: 1 }], abort.signal)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
})
