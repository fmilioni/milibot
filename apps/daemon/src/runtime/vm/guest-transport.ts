import type { Socket } from 'node:net'

import { buildConnector, fetch as undiciFetch, Pool } from 'undici'

/**
 * `quick`: short calls (health, screenshots, fs, proc control) share a small keep-alive pool, so a burst of
 * callers queues on warm connections instead of opening fresh sockets. `long`: calls that can hold a
 * connection for minutes (exec, input, provisioning, archives, `/procs/:id/events` streams) get their own
 * connections so they never starve the quick lane.
 */
export type GuestLane = 'quick' | 'long'

export interface GuestTransport {
  fetch(lane: GuestLane): typeof fetch
  close(): Promise<void>
}

export interface GuestTransportOptions {
  quickConnections?: number
  /** How long a new connection keeps the connect gate after it is established. */
  connectSettleMs?: number
  connectTimeoutMs?: number
}

/** Serializes connection attempts: QEMU's hostfwd listener resets connections that arrive together. */
class ConnectGate {
  private busy = false
  private readonly waiters: Array<() => void> = []

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.busy = true
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.busy = false
          this.waiters.shift()?.()
        })
      }
      if (this.busy) this.waiters.push(grant)
      else grant()
    })
  }
}

/**
 * Node 24's undici calls `socket.setTypeOfService(0)` right before writing each request on a fresh socket;
 * when the peer already reset the connection, macOS answers EINVAL and the throw escapes undici as an
 * uncaught exception. TOS 0 is the kernel default, so it is skipped; any other failure fails the socket.
 */
function guardTypeOfService(socket: Socket): void {
  const original = socket.setTypeOfService as ((tos: number) => Socket) | undefined
  if (typeof original !== 'function') return
  socket.setTypeOfService = function (this: Socket, tos: number) {
    if (tos === 0) return this
    try {
      return original.call(this, tos)
    } catch (err) {
      this.destroy(err as Error)
      return this
    }
  }
}

export function createGuestTransport(baseUrl: string, options: GuestTransportOptions = {}): GuestTransport {
  const gate = new ConnectGate()
  const settleMs = options.connectSettleMs ?? 50
  const base = buildConnector({ timeout: options.connectTimeoutMs ?? 10_000 })
  const connect: buildConnector.connector = (opts, callback) => {
    void gate.acquire().then((release) => {
      try {
        base(opts, (err, socket) => {
          if (err || !socket) {
            release()
            callback(err ?? new Error('connect failed'), null)
            return
          }
          guardTypeOfService(socket)
          const timer = setTimeout(release, settleMs)
          timer.unref()
          socket.once('close', () => {
            clearTimeout(timer)
            release()
          })
          callback(null, socket)
        })
      } catch (err) {
        release()
        callback(err as Error, null)
      }
    })
  }
  const pools: Record<GuestLane, Pool> = {
    quick: new Pool(baseUrl, { connections: options.quickConnections ?? 2, pipelining: 1, connect }),
    long: new Pool(baseUrl, { connections: null, pipelining: 1, connect }),
  }
  const fetchers = Object.fromEntries(
    (Object.keys(pools) as GuestLane[]).map((lane) => [
      lane,
      ((input: string | URL, init?: RequestInit) =>
        undiciFetch(input, {
          ...(init as object),
          dispatcher: pools[lane],
        } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch,
    ]),
  ) as Record<GuestLane, typeof fetch>
  return {
    fetch: (lane) => fetchers[lane],
    close: async () => {
      await Promise.all(Object.values(pools).map((pool) => pool.close().catch(() => undefined)))
    },
  }
}
