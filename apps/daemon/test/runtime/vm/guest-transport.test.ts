import { EventEmitter } from 'node:events'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { type AddressInfo, createServer, type Server, Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { GuestClient } from '../../../src/runtime/vm/guest-client'
import { installProcessGuard, isTransientNetworkError } from '../../../src/util/process-guard'

interface FakeServer {
  url: string
  accepted: number
  resets: number
  close(): Promise<void>
}

/**
 * Guest agent behind a listener that behaves like QEMU's hostfwd: a connection arriving while the previous
 * one is still being accepted (`windowMs`) is reset, and the first `resetFirst` connections are always reset.
 */
function fakeGuestServer(options: { windowMs?: number; resetFirst?: number } = {}): Promise<FakeServer> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://guest')
    const send = (body: unknown) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (url.pathname.endsWith('/events')) {
      res.setHeader('content-type', 'application/x-ndjson')
      res.write(`${JSON.stringify({ seq: 1, type: 'stdout', data: 'hi' })}\n`)
      req.on('close', () => res.end())
      return
    }
    if (url.pathname === '/exec') {
      req.resume()
      req.on('end', () => setTimeout(() => send({ code: 0, signal: null, stdout: 'ok', stderr: '' }), 30))
      return
    }
    if (url.pathname.includes('/screenshot')) {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'image/png')
        res.end(Buffer.from([1, 2, 3]))
      })
      return
    }
    send({ procs: [] })
  }
  const http = createHttpServer(handler)
  const state = { accepted: 0, resets: 0, lastAccept: 0 }
  const server: Server = createServer((socket) => {
    const now = Date.now()
    const busy = now - state.lastAccept < (options.windowMs ?? 0)
    state.lastAccept = now
    if (busy || state.accepted + state.resets < (options.resetFirst ?? 0)) {
      state.resets++
      socket.resetAndDestroy()
      return
    }
    state.accepted++
    http.emit('connection', socket)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        get accepted() {
          return state.accepted
        },
        get resets() {
          return state.resets
        },
        close: () =>
          new Promise<void>((done) => {
            http.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

function trackUncaught(): unknown[] {
  const errors: unknown[] = []
  const onError = (err: unknown) => errors.push(err)
  process.on('uncaughtException', onError)
  process.on('unhandledRejection', onError)
  cleanup.push(() => {
    process.off('uncaughtException', onError)
    process.off('unhandledRejection', onError)
  })
  return errors
}

async function setup(serverOptions: Parameters<typeof fakeGuestServer>[0] = {}) {
  const server = await fakeGuestServer(serverOptions)
  cleanup.push(() => server.close())
  const retries: string[] = []
  const client = new GuestClient(server.url, 'tok', undefined, {
    baseDelayMs: 5,
    maxDelayMs: 20,
    onRetry: (info) => retries.push(info.error),
  })
  cleanup.push(() => client.close())
  return { server, client, retries }
}

describe('guest transport', () => {
  it('queues concurrent callers on a few keep-alive connections without resets', async () => {
    const uncaught = trackUncaught()
    const { server, client } = await setup({ windowMs: 20 })
    const stream = new AbortController()
    const events = client.procEvents('p1', 0, stream.signal)
    await expect(events.next()).resolves.toMatchObject({ value: { type: 'stdout' } })

    const calls = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0
        ? client.exec({ cmd: 'true' }).then((r) => r.stdout)
        : i % 3 === 1
          ? client.listProcs().then((r) => r.procs.length)
          : client.screenshot(1).then((png) => png.length),
    )
    const results = await Promise.all(calls)
    expect(results.filter((r) => r === 'ok')).toHaveLength(20)
    expect(server.resets).toBe(0)
    // 1 stream + 2 quick connections + the long lane's execs; nowhere near one socket per request.
    expect(server.accepted).toBeLessThan(30)

    stream.abort()
    await events.return(undefined)
    expect(uncaught).toEqual([])
  })

  it('retries requests whose fresh connections are reset', async () => {
    const uncaught = trackUncaught()
    const { client, retries, server } = await setup({ resetFirst: 3 })
    const results = await Promise.all(Array.from({ length: 10 }, () => client.listProcs()))
    expect(results).toHaveLength(10)
    expect(server.resets).toBe(3)
    expect(retries.length).toBeGreaterThan(0)
    expect(uncaught).toEqual([])
  })

  it('never lets setTypeOfService EINVAL on a reset socket escape as an uncaught exception', async () => {
    const uncaught = trackUncaught()
    const original = Object.getOwnPropertyDescriptor(Socket.prototype, 'setTypeOfService')
    Object.defineProperty(Socket.prototype, 'setTypeOfService', {
      configurable: true,
      writable: true,
      value() {
        throw Object.assign(new Error('setTypeOfService EINVAL'), {
          code: 'EINVAL',
          syscall: 'setTypeOfService',
        })
      },
    })
    cleanup.push(() => {
      if (original) Object.defineProperty(Socket.prototype, 'setTypeOfService', original)
    })
    const { client } = await setup()
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? client.listProcs() : client.exec({ cmd: 'true' }))),
    )
    expect(results).toHaveLength(12)
    expect(uncaught).toEqual([])
  })
})

describe('runtime process guard', () => {
  const einval = () =>
    Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL', syscall: 'setTypeOfService' })

  it('recognizes transient socket errors', () => {
    expect(isTransientNetworkError(einval())).toBe(true)
    expect(isTransientNetworkError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(
      true,
    )
    expect(isTransientNetworkError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(true)
    expect(
      isTransientNetworkError(
        new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }),
      ),
    ).toBe(true)
    expect(
      isTransientNetworkError(Object.assign(new Error('bad'), { code: 'EINVAL', syscall: 'open' })),
    ).toBe(false)
    expect(isTransientNetworkError(new Error('boom'))).toBe(false)
    expect(isTransientNetworkError('boom')).toBe(false)
  })

  it('logs transient errors and keeps running; exits on anything else', () => {
    const target = new EventEmitter()
    const logs: string[] = []
    const exits: number[] = []
    installProcessGuard(
      (level, message) => logs.push(`${level} ${message}`),
      (code) => exits.push(code),
      target,
    )
    target.emit('uncaughtException', einval())
    target.emit('unhandledRejection', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(exits).toEqual([])
    expect(logs).toEqual([
      'warn uncaughtException ignored (transient network error)',
      'warn unhandledRejection ignored (transient network error)',
    ])
    target.emit('uncaughtException', new Error('real bug'))
    target.emit('unhandledRejection', new Error('another'))
    expect(exits).toEqual([1, 1])
  })
})
