import {
  EmbeddingError,
  findLocalEmbeddingLevel,
  type ModelDownloadProgress,
} from '@milibot/agent/embeddings'
import { FAKE_EMBEDDING_WORKER_URL } from '@milibot/agent/testing'
import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeCallServer, SupervisorCallClient } from '../../src/ipc/calls'
import type { RuntimeToSupervisor, SupervisorToRuntime } from '../../src/ipc/protocol'
import { decodeVectors, encodeVectors } from '../../src/ipc/vectors'
import { SharedLocalEmbeddingProvider } from '../../src/runtime/embeddings/supervisor-provider'
import { SharedEmbeddingModels } from '../../src/supervisor/embedding-models'

const workerUrl = FAKE_EMBEDDING_WORKER_URL
const gemma = findLocalEmbeddingLevel('embeddinggemma', 'max')!
const gemmaCompact = findLocalEmbeddingLevel('embeddinggemma', 'compact')!
const e5 = findLocalEmbeddingLevel('multilingual-e5', 'small')!

let models: SharedEmbeddingModels | null = null
const logs: Array<{ message: string; extra?: Record<string, unknown> }> = []

afterEach(async () => {
  await models?.close()
  models = null
  logs.length = 0
})

/** The supervisor's shared models with runtimes connected over an in-memory, JSON-serialized channel. */
function setup(options: { idleUnloadMs?: number } = {}) {
  models = new SharedEmbeddingModels({
    cacheDir: `/nonexistent/milibot-shared-embeddings-${process.pid}`,
    workerUrl,
    ...options,
    log: (_level, message, extra) => logs.push({ message, ...(extra ? { extra } : {}) }),
  })
  const server = new RuntimeCallServer(models.handlers())
  const runtime = (client: string) => {
    const calls = new SupervisorCallClient((message, callback) => {
      const copy = JSON.parse(JSON.stringify(message)) as RuntimeToSupervisor
      setImmediate(() => {
        callback(null)
        server.handle(client, copy, (reply) =>
          setImmediate(() => calls.handle(JSON.parse(JSON.stringify(reply)) as SupervisorToRuntime)),
        )
      })
    })
    const progress: ModelDownloadProgress[] = []
    const provider = (level = gemma) =>
      new SharedLocalEmbeddingProvider(level, {
        calls,
        modelsDir: '/nonexistent/models',
        onProgress: (p) => progress.push(p),
      })
    return { calls, provider, progress }
  }
  return { models, server, runtime }
}

describe('shared local embedding models', () => {
  it('encodes vectors for the JSON channel', () => {
    const vectors = [new Float32Array([1, -0.5, 0.25]), new Float32Array([0, 2, 3])]
    expect(decodeVectors(encodeVectors(vectors), 3)).toEqual(vectors)
    expect(decodeVectors(encodeVectors([]), 3)).toEqual([])
  })

  it('serves two runtimes from one model process, with the space and truncation of the local provider', async () => {
    const { models, runtime } = setup()
    const a = runtime('ws_a#1')
    const b = runtime('ws_b#2')
    const providerA = a.provider()
    const providerB = b.provider(gemmaCompact)
    expect(providerA.key).toBe(`local:embeddinggemma-300m:${gemma.model.dtype}:768`)
    expect(providerB.dimensions).toBe(256)
    expect(providerA.maxInputTokens).toBe(gemma.model.maxInputTokens)
    expect(providerA.isDownloaded()).toBe(false)
    expect(providerA.loaded).toBe(false)

    const [prepA, prepB] = await Promise.all([providerA.prepare(), providerB.prepare()])
    expect(prepA.downloaded).toBe(true)
    expect(prepB.downloaded).toBe(true)
    // Both runtimes were waiting on the model, so both saw the download.
    expect(a.progress.map((p) => p.progress)).toEqual([0.5, 1])
    expect(b.progress.map((p) => p.progress)).toEqual([0.5, 1])
    expect(providerA.loaded).toBe(true)

    const [resA, resB] = await Promise.all([
      providerA.embed(['a', 'abc'], 'query'),
      providerB.embed(['abcd'], 'document'),
    ])
    const ratio = (v: Float32Array) => v[0]! / v[1]!
    expect(resA.vectors).toHaveLength(2)
    expect(resA.vectors[0]).toHaveLength(768)
    expect(ratio(resA.vectors[1]!)).toBeCloseTo(gemma.model.queryPrefix.length + 3, 3)
    expect(resA.usage?.tokens).toBe(2 * gemma.model.queryPrefix.length + 4)
    expect(resB.vectors[0]).toHaveLength(256)
    expect(Math.hypot(...resB.vectors[0]!)).toBeCloseTo(1, 5)
    expect(await providerA.embed([], 'document')).toEqual({ vectors: [], usage: { tokens: 0 } })

    await runtime('ws_c#3').provider(e5).embed(['x'], 'document')
    expect(models.spawnCount()).toBe(2)
    expect(models.runningProcesses()).toBe(2)
    expect(logs.filter((l) => l.message === 'embedding model process started')).toHaveLength(2)
  })

  it('maps failures to embedding errors and restarts a crashed model on the next request', async () => {
    const { models, runtime } = setup()
    const provider = runtime('ws_a#1').provider()
    await provider.embed(['warm'], 'document')
    const firstPid = models.pids()[0]
    const crash = provider.embed(['CRASH'], 'document')
    await expect(crash).rejects.toBeInstanceOf(EmbeddingError)
    await expect(crash).rejects.toMatchObject({ code: 'inference_failed' })
    expect((await provider.embed(['again'], 'document')).vectors).toHaveLength(1)
    expect(models.pids()[0]).not.toBe(firstPid)
    expect(logs.some((l) => l.message === 'embedding model process exited')).toBe(true)
  })

  it('stops the model work of an aborted call', async () => {
    const { runtime, server } = setup()
    const provider = runtime('ws_a#1').provider()
    const controller = new AbortController()
    const pending = provider.embed(['SLOW'], 'document', controller.signal)
    setTimeout(() => controller.abort(), 30)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    await new Promise((r) => setTimeout(r, 20))
    expect(server.active()).toBe(0)
  })

  it('drops the requests of a runtime that died, and unloads with the memory in the log', async () => {
    const { models, runtime, server } = setup()
    const runtimeA = runtime('ws_a#1')
    const a = runtimeA.provider()
    const b = runtime('ws_b#2').provider()
    await a.prepare()
    const slow = b.embed(['SLOW'], 'document')
    const queued = a.embed(['queued'], 'document').catch((err: unknown) => err)
    await new Promise((r) => setTimeout(r, 30))
    expect(server.active('ws_a#1')).toBe(1)
    server.dropClient('ws_a#1')
    expect(server.active('ws_a#1')).toBe(0)
    // B's request is not affected.
    expect((await slow).vectors).toHaveLength(1)
    runtimeA.calls.close()
    expect(await queued).toMatchObject({ name: 'EmbeddingError', code: 'inference_failed' })
    await models.close()
    const unloaded = logs.find((l) => l.message === 'embedding model unloaded')
    expect(unloaded?.extra).toMatchObject({ reason: 'shutdown', rssMb: expect.any(Number) })
    expect(models.runningProcesses()).toBe(0)
  })

  it('unloads the model after the idle timeout', async () => {
    const { models, runtime } = setup({ idleUnloadMs: 50 })
    await runtime('ws_a#1').provider().embed(['a'], 'document')
    expect(models.runningProcesses()).toBe(1)
    for (let i = 0; i < 100 && models.runningProcesses() > 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(models.runningProcesses()).toBe(0)
    expect(logs.find((l) => l.message === 'embedding model unloaded')?.extra).toMatchObject({
      reason: 'idle',
    })
  })
})
