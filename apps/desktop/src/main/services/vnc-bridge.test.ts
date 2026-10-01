import { createServer, type Server } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { VncBridge } from './vnc-bridge'

let echo: Server
let echoPort: number
let bridge: VncBridge
/** Ports the fake daemon reports per bot. */
let ports: Map<string, number>

const bot = (botId: string) => ({ workspaceId: 'ws_1', botId })

beforeEach(async () => {
  echo = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const address = echo.address()
  echoPort = typeof address === 'object' && address ? address.port : 0
  ports = new Map([['b1', echoPort]])
  bridge = new VncBridge({
    resolvePort: async ({ botId }) => {
      const port = ports.get(botId)
      if (port === undefined) throw new Error('unknown bot')
      return port
    },
  })
})

afterEach(async () => {
  await bridge.close()
  await new Promise<void>((resolve) => echo.close(() => resolve()))
})

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['binary'])
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
  })
}

function roundTrip(ws: WebSocket, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data as Buffer))
    ws.send(payload)
  })
}

describe('VncBridge', () => {
  it('pipes binary frames to the loopback port the daemon reports for the bot', async () => {
    const url = await bridge.issue(1, bot('b1'))
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/vnc\?t=[\w-]{40,}$/)
    const ws = await open(url)
    expect(ws.protocol).toBe('binary')
    const reply = await roundTrip(ws, Buffer.from('RFB 003.008\n'))
    expect(reply.toString()).toBe('RFB 003.008\n')
    ws.close()
  })

  it('reuses one ticket per window and port', async () => {
    expect(await bridge.issue(1, bot('b1'))).toBe(await bridge.issue(1, bot('b1')))
    expect(await bridge.issue(2, bot('b1'))).not.toBe(await bridge.issue(1, bot('b1')))
  })

  it('rejects connections without a valid ticket', async () => {
    const url = await bridge.issue(1, bot('b1'))
    const base = url.slice(0, url.indexOf('?'))
    await expect(open(base)).rejects.toThrow('HTTP 401')
    await expect(open(`${base}?t=forged`)).rejects.toThrow('HTTP 401')
    await expect(open(url.replace('/vnc?', '/other?'))).rejects.toThrow('HTTP 401')
  })

  it('revokes tickets and live connections when the window closes', async () => {
    const url = await bridge.issue(7, bot('b1'))
    const ws = await open(url)
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
    bridge.revokeOwner(7)
    await closed
    await expect(open(url)).rejects.toThrow('HTTP 401')
  })

  it('refuses unknown bots and invalid ports', async () => {
    await expect(bridge.issue(1, bot('nobody'))).rejects.toThrow('unknown bot')
    ports.set('b2', 0)
    await expect(bridge.issue(1, bot('b2'))).rejects.toThrow('Invalid VNC port')
    ports.set('b2', 70000)
    await expect(bridge.issue(1, bot('b2'))).rejects.toThrow('Invalid VNC port')
  })

  it('closes the socket when the VNC port is not listening', async () => {
    const dead = createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const address = dead.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    ports.set('b3', port)
    const ws = await open(await bridge.issue(1, bot('b3')))
    await new Promise<void>((resolve) => ws.once('close', () => resolve()))
  })
})
