import { describe, expect, it } from 'vitest'

import { type RuntimeCallHandlers, RuntimeCallServer, SupervisorCallClient } from '../../src/ipc/calls'
import type { RuntimeToSupervisor, SupervisorToRuntime } from '../../src/ipc/protocol'

const progress = (loadedBytes: number) => ({
  modelId: 'm',
  loadedBytes,
  totalBytes: 100,
  progress: loadedBytes / 100,
  file: null,
  done: loadedBytes === 100,
})

/** A client and the server connected like the fork channel (asynchronous, JSON-serialized messages). */
function connect(handlers: RuntimeCallHandlers, client = 'ws_a#1') {
  const server = new RuntimeCallServer(handlers)
  const sent: RuntimeToSupervisor[] = []
  const replies: SupervisorToRuntime[] = []
  let connected = true
  const calls = new SupervisorCallClient((message, callback) => {
    if (!connected) {
      callback(new Error('channel closed'))
      return
    }
    sent.push(message)
    const copy = JSON.parse(JSON.stringify(message)) as RuntimeToSupervisor
    setImmediate(() => {
      callback(null)
      server.handle(client, copy, (reply) => {
        replies.push(reply)
        setImmediate(() => calls.handle(JSON.parse(JSON.stringify(reply)) as SupervisorToRuntime))
      })
    })
  })
  return { server, calls, sent, replies, disconnect: () => (connected = false) }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('runtime → supervisor calls', () => {
  it('returns results, relays progress and passes the caller id', async () => {
    let seenClient = ''
    const { calls, server } = connect({
      'embedding.prepare': async (args, context) => {
        seenClient = context.client
        context.progress(progress(50))
        context.progress(progress(100))
        return { loadMs: args.level.length, downloaded: true }
      },
    })
    const seen: number[] = []
    const result = await calls.call(
      'embedding.prepare',
      { family: 'embeddinggemma', level: 'max' },
      { onProgress: (p) => seen.push(p.loadedBytes) },
    )
    expect(result).toEqual({ loadMs: 3, downloaded: true })
    expect(seen).toEqual([50, 100])
    expect(seenClient).toBe('ws_a#1')
    expect(server.active()).toBe(0)
  })

  it('carries error codes and fails unknown methods', async () => {
    const { calls } = connect({
      'embedding.prepare': async () => {
        throw Object.assign(new Error('offline'), { code: 'model_download_failed' })
      },
      'embedding.embed': async () => {
        throw new Error('plain')
      },
    })
    await expect(
      calls.call('embedding.prepare', { family: 'embeddinggemma', level: 'max' }),
    ).rejects.toMatchObject({ name: 'RuntimeCallError', code: 'model_download_failed', message: 'offline' })
    await expect(
      calls.call('embedding.embed', { family: 'embeddinggemma', level: 'max', texts: ['a'], kind: 'query' }),
    ).rejects.toMatchObject({ code: 'internal', message: 'plain' })
    const bare = connect({})
    await expect(
      bare.calls.call('embedding.prepare', { family: 'embeddinggemma', level: 'max' }),
    ).rejects.toMatchObject({ code: 'unknown_method' })
  })

  it('propagates an abort to the handler and never answers the cancelled call', async () => {
    let handlerSignal: AbortSignal | null = null
    const { calls, sent, replies, server } = connect({
      'embedding.prepare': (_args, context) =>
        new Promise((_resolve, reject) => {
          handlerSignal = context.signal
          context.signal.addEventListener('abort', () => reject(new Error('stopped')))
        }),
    })
    const controller = new AbortController()
    const pending = calls.call(
      'embedding.prepare',
      { family: 'embeddinggemma', level: 'max' },
      {
        signal: controller.signal,
      },
    )
    await until(() => handlerSignal !== null)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    await until(() => handlerSignal?.aborted === true)
    expect(sent.map((m) => m.type)).toEqual(['call', 'call_cancel'])
    await new Promise((r) => setTimeout(r, 20))
    expect(replies).toEqual([])
    expect(server.active()).toBe(0)
  })

  it('times out after a quiet period, which progress extends', async () => {
    const { calls, sent } = connect({
      'embedding.prepare': async (_args, context) => {
        for (let i = 1; i <= 4; i++) {
          await new Promise((r) => setTimeout(r, 40))
          context.progress(progress(i * 25))
        }
        return { loadMs: 1, downloaded: true }
      },
      'embedding.embed': (_args, context) =>
        new Promise((_resolve, reject) =>
          context.signal.addEventListener('abort', () => reject(new Error('x'))),
        ),
    })
    await expect(
      calls.call('embedding.prepare', { family: 'embeddinggemma', level: 'max' }, { timeoutMs: 100 }),
    ).resolves.toEqual({ loadMs: 1, downloaded: true })
    await expect(
      calls.call(
        'embedding.embed',
        { family: 'embeddinggemma', level: 'max', texts: ['a'], kind: 'document' },
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(sent.at(-1)?.type).toBe('call_cancel')
  })

  it('aborts the calls of a runtime that exits, and fails calls once the channel is gone', async () => {
    const signals: AbortSignal[] = []
    const { calls, server, replies, disconnect } = connect({
      'embedding.prepare': (_args, context) =>
        new Promise((_resolve, reject) => {
          signals.push(context.signal)
          context.signal.addEventListener('abort', () => reject(new Error('dropped')))
        }),
    })
    const pending = calls.call('embedding.prepare', { family: 'embeddinggemma', level: 'max' })
    await until(() => server.active('ws_a#1') === 1)
    server.dropClient('ws_a#1')
    expect(signals[0]?.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(replies).toEqual([])
    calls.close('supervisor went away')
    await expect(pending).rejects.toMatchObject({ code: 'disconnected', message: 'supervisor went away' })
    await expect(
      calls.call('embedding.prepare', { family: 'embeddinggemma', level: 'max' }),
    ).rejects.toMatchObject({ code: 'disconnected' })
    disconnect()
  })

  it('fails a call whose message cannot be sent', async () => {
    const { calls, disconnect } = connect({
      'embedding.prepare': async () => ({ loadMs: 1, downloaded: false }),
    })
    disconnect()
    await expect(
      calls.call('embedding.prepare', { family: 'embeddinggemma', level: 'max' }),
    ).rejects.toMatchObject({ code: 'disconnected', message: 'channel closed' })
  })
})
