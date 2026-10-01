import { afterEach, describe, expect, it } from 'vitest'

import { findLocalEmbeddingLevel } from './catalog'
import { type LocalEmbeddingOptions, LocalEmbeddingProvider } from './local'
import type { ModelDownloadProgress } from './types'

// A fake worker speaking the same IPC protocol: tests cover the host (process lifecycle, abort,
// crashes, idle unload, sharing, truncation) without transformers.js or any download.
const workerUrl = new URL('./fixtures/fake-worker.mjs', import.meta.url)
const gemma = findLocalEmbeddingLevel('embeddinggemma', 'max')!
const gemmaCompact = findLocalEmbeddingLevel('embeddinggemma', 'compact')!
const e5 = findLocalEmbeddingLevel('multilingual-e5', 'small')!

let counter = 0
const providers: LocalEmbeddingProvider[] = []

/** Each test gets its own (never created) cache dir, so model hosts are not shared across tests. */
function make(
  level = gemma,
  options: Partial<LocalEmbeddingOptions> = {},
  cacheDir = `/nonexistent/milibot-embeddings-${process.pid}-${counter++}`,
): LocalEmbeddingProvider {
  const provider = new LocalEmbeddingProvider(level, { cacheDir, workerUrl, ...options })
  providers.push(provider)
  return provider
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.dispose()))
})

describe('LocalEmbeddingProvider', () => {
  it('names the space after model, dtype and size, and starts no process until used', () => {
    const provider = make()
    expect(provider.key).toBe(`local:embeddinggemma-300m:${gemma.model.dtype}:768`)
    expect(provider.dimensions).toBe(768)
    expect(provider.maxInputTokens).toBe(2048)
    expect(provider.host.running).toBe(false)
    expect(provider.isDownloaded()).toBe(false)
  })

  it('embeds in a worker process with the model prefixes, in input order', async () => {
    const provider = make()
    const res = await provider.embed(['a', 'abc'], 'query')
    expect(provider.host.running).toBe(true)
    expect(provider.host.pid).not.toBe(process.pid)
    expect(res.vectors).toHaveLength(2)
    expect(res.vectors[0]).toHaveLength(768)
    // The fake puts the text length (prefix included) in dimension 0.
    const prefix = gemma.model.queryPrefix.length
    const ratio = (v: Float32Array) => v[0]! / v[1]!
    expect(ratio(res.vectors[0]!)).toBeCloseTo(prefix + 1, 3)
    expect(ratio(res.vectors[1]!)).toBeCloseTo(prefix + 3, 3)
    expect(res.usage?.tokens).toBe(2 * prefix + 4)
    const doc = await provider.embed(['a'], 'document')
    expect(ratio(doc.vectors[0]!)).toBeCloseTo(gemma.model.documentPrefix.length + 1, 3)
    expect(await provider.embed([], 'document')).toEqual({ vectors: [], usage: { tokens: 0 } })
  })

  it('truncates and renormalizes below the native size', async () => {
    const res = await make(gemmaCompact).embed(['abc'], 'document')
    expect(res.vectors[0]).toHaveLength(256)
    expect(Math.hypot(...res.vectors[0]!)).toBeCloseTo(1, 5)
  })

  it('shares one worker between levels of the same model and reports download progress to all', async () => {
    const cacheDir = `/nonexistent/milibot-embeddings-shared-${process.pid}`
    const seen: ModelDownloadProgress[] = []
    const max = make(gemma, { onProgress: (p) => seen.push(p) }, cacheDir)
    const compact = make(gemmaCompact, {}, cacheDir)
    const other = make(e5, {}, cacheDir)
    expect(compact.host).toBe(max.host)
    expect(other.host).not.toBe(max.host)
    expect(await compact.prepare()).toEqual({ loadMs: 1, downloaded: true })
    expect(seen.map((p) => p.progress)).toEqual([0.5, 1])
    expect(seen.at(-1)).toMatchObject({ modelId: gemma.model.repo, done: true })
    await compact.dispose()
    expect(max.host.running).toBe(true)
    await max.dispose()
    expect(max.host.running).toBe(false)
  })

  it('reports download failures with their code', async () => {
    const provider = make(gemma, { remoteHost: 'offline' })
    await expect(provider.embed(['a'], 'document')).rejects.toMatchObject({
      name: 'EmbeddingError',
      code: 'model_download_failed',
    })
  })

  it('aborts a request without waiting for the worker', async () => {
    const provider = make()
    const controller = new AbortController()
    const pending = provider.embed(['SLOW'], 'document', controller.signal)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    // The worker is still usable afterwards.
    expect((await provider.embed(['b'], 'document')).vectors).toHaveLength(1)
    const aborted = new AbortController()
    aborted.abort()
    await expect(provider.embed(['c'], 'document', aborted.signal)).rejects.toMatchObject({ code: 'aborted' })
  })

  it('fails pending requests when the worker dies and starts a new one next time', async () => {
    const provider = make()
    await provider.embed(['warm'], 'document')
    const firstPid = provider.host.pid
    await expect(provider.embed(['CRASH'], 'document')).rejects.toMatchObject({
      code: 'inference_failed',
      message: expect.stringContaining('code 3'),
    })
    expect(provider.host.running).toBe(false)
    await provider.embed(['again'], 'document')
    expect(provider.host.pid).not.toBe(firstPid)
  })

  it('stops the worker after the idle timeout', async () => {
    const provider = make(gemma, { idleUnloadMs: 50 })
    await provider.embed(['a'], 'document')
    expect(provider.host.running).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(provider.host.running).toBe(false)
    expect((await provider.embed(['b'], 'document')).vectors).toHaveLength(1)
  })

  it('fails with model_load_failed when the worker dies before the model answered', async () => {
    const provider = make()
    await expect(provider.embed(['CRASH'], 'document')).rejects.toMatchObject({ code: 'model_load_failed' })
    expect((await provider.embed(['ok'], 'document')).vectors).toHaveLength(1)
  })

  it('runs queries before waiting document batches, merged, and takes document turns per client', async () => {
    const { host } = make()
    const order: string[] = []
    const track = (name: string, promise: Promise<{ vectors: Float32Array[]; tokens: number }>) =>
      promise.then((res) => {
        order.push(name)
        return res
      })
    const first = track('slow', host.embed(['SLOW'], { client: 'A' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rest = [
      track('a2', host.embed(['a2'], { client: 'A' })),
      track('a3', host.embed(['a3'], { client: 'A' })),
      track('b1', host.embed(['b1'], { client: 'B' })),
      track('q1', host.embed(['q1'], { client: 'B', kind: 'query' })),
      track('q22', host.embed(['q22', 'q'], { client: 'A', kind: 'query' })),
    ]
    expect(host.queued).toBe(5)
    const results = await Promise.all([first, ...rest])
    expect(order).toEqual(['slow', 'q1', 'q22', 'a2', 'b1', 'a3'])
    // Merged runs split vectors and tokens back per request.
    expect(results[4]).toMatchObject({ tokens: 2 })
    expect(results[5]!.vectors).toHaveLength(2)
    expect(results[5]!.tokens).toBe(4)
  })

  it('drops an aborted request from the queue without touching the others', async () => {
    const { host } = make()
    const slow = host.embed(['SLOW'])
    const controller = new AbortController()
    const queued = host.embed(['queued'], { signal: controller.signal })
    const other = host.embed(['other'])
    controller.abort()
    await expect(queued).rejects.toMatchObject({ code: 'aborted' })
    expect(host.queued).toBe(1)
    expect((await slow).vectors).toHaveLength(1)
    expect((await other).vectors).toHaveLength(1)
  })

  it('fails queued requests when the model is unloaded', async () => {
    const { host } = make()
    const slow = host.embed(['SLOW'])
    const queued = host.embed(['queued'])
    const failed = Promise.all([
      expect(slow).rejects.toMatchObject({ code: 'aborted' }),
      expect(queued).rejects.toMatchObject({ code: 'aborted' }),
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    await host.unload('shutdown')
    await failed
    expect(host.running).toBe(false)
  })

  it('reports the worker memory', async () => {
    const provider = make()
    expect(await provider.host.stats()).toBeNull()
    await provider.prepare()
    const stats = await provider.host.stats()
    expect(stats!.rssBytes).toBeGreaterThan(0)
    expect(stats!.peakRssBytes).toBeGreaterThanOrEqual(stats!.rssBytes / 2)
  })
})
