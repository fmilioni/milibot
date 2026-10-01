import type { LineChannel } from '../../src/runtime/cdp'

export type ChromeHandler = (method: string, params: Record<string, unknown>) => unknown

/** A Chrome that answers CDP over an in-memory line channel. */
export function fakeChrome(handler: ChromeHandler) {
  const sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
  let deliver: (line: string) => void = () => {}
  const channel: LineChannel = {
    async start(onLine) {
      deliver = onLine
      queueMicrotask(() => deliver(JSON.stringify({ relay: 'open', browser: 'Chrome/150' })))
    },
    async send(line) {
      const msg = JSON.parse(line) as Record<string, unknown>
      if (msg.relay === 'list') {
        const list = [
          { id: 'T1', type: 'page', title: 'Inbox', url: 'https://mail.google.com/' },
          { id: 'S1', type: 'service_worker', title: '', url: 'https://mail.google.com/sw.js' },
        ]
        queueMicrotask(() => deliver(JSON.stringify({ relay: 'list', id: msg.id, list })))
        return
      }
      const call = {
        method: msg.method as string,
        params: (msg.params ?? {}) as Record<string, unknown>,
        ...(msg.sessionId ? { sessionId: msg.sessionId as string } : {}),
      }
      sent.push(call)
      let result: unknown
      try {
        result = handler(call.method, call.params) ?? {}
      } catch (err) {
        queueMicrotask(() =>
          deliver(JSON.stringify({ id: msg.id, error: { code: -32000, message: (err as Error).message } })),
        )
        return
      }
      queueMicrotask(() => deliver(JSON.stringify({ id: msg.id, result })))
    },
    async close() {},
  }
  return { channel, sent }
}
