import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

import { type WebSocket, WebSocketServer } from 'ws'

import type { VncTarget } from '../../bridge/contract'

const LOOPBACK = '127.0.0.1'
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const PATH = '/vnc'

interface Ticket {
  owner: number
  port: number
}

export interface VncBridgeOptions {
  resolvePort: (target: VncTarget) => Promise<number>
  /** Host the bridge dials; always loopback in production (tests may point at a fake server). */
  targetHost?: string
  connectTimeoutMs?: number
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

/**
 * TCP→WebSocket bridge so noVNC (browser WebSockets only) can reach the VM's VNC ports. Listens on
 * loopback only; every connection needs a ticket issued to a specific window for a bot's screen (its
 * port resolved through the daemon), and tickets die with their window.
 */
export class VncBridge {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private port = 0
  private readonly tickets = new Map<string, Ticket>()
  private readonly byOwner = new Map<number, Map<number, string>>()
  private readonly sockets = new Map<number, Set<WebSocket>>()
  private readonly resolvePort: (target: VncTarget) => Promise<number>
  private readonly targetHost: string
  private readonly connectTimeoutMs: number
  private starting: Promise<number> | null = null

  constructor(options: VncBridgeOptions) {
    this.resolvePort = options.resolvePort
    this.targetHost = options.targetHost ?? LOOPBACK
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000
  }

  start(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const wss = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
      })
      const server = createServer((_req, res) => {
        res.writeHead(404).end()
      })
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
      server.once('error', reject)
      server.listen(0, LOOPBACK, () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('VNC bridge failed to bind'))
          return
        }
        this.server = server
        this.wss = wss
        this.port = address.port
        resolve(address.port)
      })
    })
    return this.starting
  }

  /** Returns the WebSocket URL for `owner` (a webContents id) to reach the bot's screen. */
  async issue(owner: number, target: VncTarget): Promise<string> {
    const port = await this.resolvePort(target)
    if (!isValidPort(port)) throw new Error('Invalid VNC port')
    const bridgePort = await this.start()
    let perOwner = this.byOwner.get(owner)
    if (!perOwner) {
      perOwner = new Map()
      this.byOwner.set(owner, perOwner)
    }
    let token = perOwner.get(port)
    if (!token) {
      token = randomBytes(32).toString('base64url')
      perOwner.set(port, token)
      this.tickets.set(token, { owner, port })
    }
    return `ws://${LOOPBACK}:${bridgePort}${PATH}?t=${token}`
  }

  /** Revokes the window's tickets and closes its open connections. */
  revokeOwner(owner: number): void {
    for (const token of this.byOwner.get(owner)?.values() ?? []) this.tickets.delete(token)
    this.byOwner.delete(owner)
    for (const ws of this.sockets.get(owner) ?? []) ws.close(1000, 'window closed')
    this.sockets.delete(owner)
  }

  async close(): Promise<void> {
    for (const owner of [...this.byOwner.keys()]) this.revokeOwner(owner)
    this.wss?.close()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
    this.wss = null
    this.starting = null
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`)
    const token = url.searchParams.get('t')
    const ticket = url.pathname === PATH && token ? this.tickets.get(token) : undefined
    if (!ticket || !this.wss) {
      reject(socket, 401, 'Unauthorized')
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.pipe(ws, ticket))
  }

  private pipe(ws: WebSocket, ticket: Ticket): void {
    let owned = this.sockets.get(ticket.owner)
    if (!owned) {
      owned = new Set()
      this.sockets.set(ticket.owner, owned)
    }
    owned.add(ws)

    const tcp = connect({ host: this.targetHost, port: ticket.port })
    tcp.setNoDelay(true)
    tcp.setTimeout(this.connectTimeoutMs, () => tcp.destroy(new Error('VNC connect timeout')))
    tcp.once('connect', () => tcp.setTimeout(0))

    tcp.on('data', (chunk) => {
      if (ws.readyState !== ws.OPEN) return
      ws.send(chunk, { binary: true })
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        tcp.pause()
        const resume = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < MAX_BUFFERED_BYTES / 4) {
            clearInterval(resume)
            tcp.resume()
          }
        }, 20)
      }
    })
    ws.on('message', (data, isBinary) => {
      if (!isBinary && typeof data === 'string') return
      const chunks = Array.isArray(data) ? data : [data instanceof ArrayBuffer ? Buffer.from(data) : data]
      for (const chunk of chunks) tcp.write(chunk)
    })

    const cleanup = () => {
      owned?.delete(ws)
      if (!tcp.destroyed) tcp.destroy()
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close()
    }
    tcp.on('close', cleanup)
    tcp.on('error', () => cleanup())
    ws.on('close', cleanup)
    ws.on('error', () => cleanup())
  }
}
