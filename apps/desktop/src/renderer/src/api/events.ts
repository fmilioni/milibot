import { AUTH_QUERY_PARAM } from '@milibot/shared'

import type { DaemonConnection } from '../../../bridge/contract'

export interface EventStreamOptions {
  connection: () => DaemonConnection
  path: string
  onFrame: (frame: unknown) => void
  onOpen?: () => void
  onClose?: () => void
}

/** Reconnecting WebSocket; resolves the connection lazily so a restarted daemon is picked up. */
export function openEventStream(options: EventStreamOptions): () => void {
  let socket: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    if (stopped) return
    const { baseUrl, token } = options.connection()
    const url = `${baseUrl.replace(/^http/, 'ws')}${options.path}?${AUTH_QUERY_PARAM}=${encodeURIComponent(token)}`
    socket = new WebSocket(url)
    socket.onopen = () => {
      attempt = 0
      options.onOpen?.()
    }
    socket.onmessage = (message) => {
      try {
        options.onFrame(JSON.parse(String(message.data)))
      } catch (err) {
        console.error('[events] bad frame', err)
      }
    }
    socket.onclose = () => {
      socket = null
      options.onClose?.()
      if (stopped) return
      const delay = Math.min(5_000, 300 * 2 ** attempt++)
      retryTimer = setTimeout(connect, delay)
    }
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(retryTimer)
    socket?.close()
  }
}
