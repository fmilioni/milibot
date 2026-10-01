/**
 * Embedding worker process: loads one model with transformers.js + onnxruntime-node and embeds
 * batches, talking to `LocalModelHost` over the fork IPC channel. A child process and not a
 * worker_thread because only process exit gives onnxruntime's memory back to the OS (a terminated
 * worker leaves the process footprint at its peak). Only `node:*`, transformers.js and type imports,
 * so it runs as the bundle entry `apps/daemon/dist/embedding-worker.js` and under tsx.
 *
 *   argv[2] = JSON of `EmbeddingWorkerConfig`
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { AutoModel, AutoTokenizer, env, mean_pooling, type Tensor } from '@huggingface/transformers'

import type { EmbeddingWorkerConfig, EmbeddingWorkerRequest, EmbeddingWorkerResponse } from './local-protocol'
import type { EmbeddingErrorCode } from './types'

const config = JSON.parse(process.argv[2] ?? '{}') as EmbeddingWorkerConfig
const { model: spec } = config
const modelDir = join(config.cacheDir, spec.repo)

env.cacheDir = config.cacheDir
// The cache layout (`<cacheDir>/<repo>/<file>`) is also a valid local model path, which lets a cached
// model load with `local_files_only` (no network at all).
env.localModelPath = config.cacheDir
env.allowLocalModels = true
env.allowRemoteModels = true
if (config.remoteHost) env.remoteHost = config.remoteHost

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>
type Model = Awaited<ReturnType<typeof AutoModel.from_pretrained>>

let loading: Promise<{ tokenizer: Tokenizer; model: Model; downloaded: boolean }> | null = null
const cancelled = new Set<number>()
/** One request at a time: concurrent runs would only multiply the activation memory. */
let queue: Promise<void> = Promise.resolve()

function send(message: EmbeddingWorkerResponse): void {
  process.send?.(message)
}

class WorkerError extends Error {
  code: EmbeddingErrorCode

  constructor(code: EmbeddingErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function filesPresent(): boolean {
  return spec.files.every((file) => existsSync(join(modelDir, file)))
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** transformers.js downloads to `<file>.tmp.<pid>.<rand>` and renames; drop leftovers of dead downloads. */
function removeStaleDownloads(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      removeStaleDownloads(path)
      continue
    }
    const match = /\.tmp\.(\d+)\.[a-z0-9]+$/.exec(entry)
    if (match && !processAlive(Number(match[1]))) rmSync(path, { force: true })
  }
}

let lastProgressAt = 0

function onProgress(info: unknown): void {
  const p = info as {
    status?: string
    loaded?: number
    total?: number
    files?: Record<string, { loaded: number; total: number }>
  }
  if (p.status !== 'progress_total') return
  const now = Date.now()
  const done = p.total !== undefined && p.loaded === p.total
  if (!done && now - lastProgressAt < 250) return
  lastProgressAt = now
  const current = Object.entries(p.files ?? {}).find(([, f]) => f.loaded < f.total)?.[0] ?? null
  send({
    type: 'progress',
    progress: {
      modelId: spec.repo,
      loadedBytes: p.loaded ?? 0,
      totalBytes: p.total ?? 0,
      progress: p.total ? Math.min(1, (p.loaded ?? 0) / p.total) : 0,
      file: current,
      done,
    },
  })
}

async function load(): Promise<{ tokenizer: Tokenizer; model: Model; downloaded: boolean }> {
  const cached = filesPresent()
  if (!cached) removeStaleDownloads(modelDir)
  // Progress is only reported for downloads (a cached load emits a meaningless 100%).
  const options = cached ? { local_files_only: true } : { progress_callback: onProgress }
  try {
    const tokenizer = await AutoTokenizer.from_pretrained(spec.repo, options)
    const model = await AutoModel.from_pretrained(spec.repo, {
      ...options,
      dtype: spec.dtype,
      device: 'cpu',
      session_options: { intraOpNumThreads: config.threads, interOpNumThreads: 1 },
    })
    return { tokenizer, model, downloaded: !cached }
  } catch (err) {
    const message = (err as Error).message
    if (!filesPresent()) {
      throw new WorkerError(
        'model_download_failed',
        `could not download ${spec.repo} to ${modelDir}: ${message}`,
      )
    }
    throw new WorkerError('model_load_failed', `could not load ${spec.repo}: ${message}`)
  }
}

function ensureLoaded(): Promise<{ tokenizer: Tokenizer; model: Model; downloaded: boolean }> {
  if (!loading) {
    const attempt = load()
    loading = attempt
    // A failed load is retried by the next request.
    attempt.catch(() => {
      if (loading === attempt) loading = null
    })
  }
  return loading
}

function unitRows(data: Float32Array, rows: number, dims: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let r = 0; r < rows; r++) {
    const row = data.slice(r * dims, (r + 1) * dims)
    let sum = 0
    for (let i = 0; i < dims; i++) sum += row[i]! * row[i]!
    const n = Math.sqrt(sum)
    if (n > 0) for (let i = 0; i < dims; i++) row[i]! /= n
    out.push(row)
  }
  return out
}

/**
 * Batches of similar length (longest first) bounded by `batchTokens` of padded input: throughput is
 * flat above a few texts per batch, while activation memory grows with batch × length².
 */
function batches(texts: string[]): number[][] {
  const order = texts.map((_, i) => i).sort((a, b) => texts[b]!.length - texts[a]!.length)
  const estimate = (i: number) => Math.min(spec.maxInputTokens, Math.ceil(texts[i]!.length / 3) + 2)
  const out: number[][] = []
  let current: number[] = []
  for (const i of order) {
    const padded = current.length > 0 ? estimate(current[0]!) : estimate(i)
    if (current.length > 0 && (current.length + 1) * padded > spec.batchTokens) {
      out.push(current)
      current = []
    }
    current.push(i)
  }
  if (current.length > 0) out.push(current)
  return out
}

async function embed(id: number, texts: string[]): Promise<void> {
  const { tokenizer, model } = await ensureLoaded()
  const vectors = new Array<Float32Array>(texts.length)
  const counts = new Array<number>(texts.length).fill(0)
  for (const indices of batches(texts)) {
    if (cancelled.delete(id)) throw new WorkerError('aborted', 'embedding aborted')
    const inputs = tokenizer(
      indices.map((i) => texts[i]!),
      { padding: true, truncation: true, max_length: spec.maxInputTokens },
    ) as { input_ids: Tensor; attention_mask: Tensor }
    const output = (await model(inputs)) as Record<string, Tensor | undefined>
    const pooled =
      spec.pooling === 'model'
        ? output.sentence_embedding
        : output.last_hidden_state && mean_pooling(output.last_hidden_state, inputs.attention_mask)
    if (!pooled) throw new WorkerError('inference_failed', `${spec.repo} returned no embeddings`)
    const rows = unitRows(pooled.data as Float32Array, indices.length, pooled.dims[1]!)
    const mask = inputs.attention_mask.data as BigInt64Array
    const width = mask.length / indices.length
    indices.forEach((original, row) => {
      vectors[original] = rows[row]!
      for (let i = row * width; i < (row + 1) * width; i++) counts[original]! += Number(mask[i])
    })
  }
  cancelled.delete(id)
  send({ type: 'result', id, vectors, tokens: counts.reduce((a, b) => a + b, 0), counts })
}

function fail(id: number, err: unknown): void {
  const code = err instanceof WorkerError ? err.code : 'inference_failed'
  send({ type: 'error', id, code, message: (err as Error).message })
}

process.on('message', (message: EmbeddingWorkerRequest) => {
  switch (message.type) {
    case 'load': {
      const started = Date.now()
      ensureLoaded().then(
        ({ downloaded }) =>
          send({ type: 'loaded', id: message.id, loadMs: Date.now() - started, downloaded }),
        (err: unknown) => fail(message.id, err),
      )
      break
    }
    case 'embed': {
      const { id, texts } = message
      queue = queue
        .then(() => {
          if (cancelled.delete(id)) throw new WorkerError('aborted', 'embedding aborted')
          return embed(id, texts)
        })
        .catch((err: unknown) => fail(id, err))
      break
    }
    case 'cancel':
      cancelled.add(message.id)
      break
    case 'stats':
      send({
        type: 'stats',
        id: message.id,
        rssBytes: process.memoryUsage.rss(),
        // maxRSS is in KiB.
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      })
      break
  }
})

// The parent went away (crash, SIGKILL): nothing else will ever talk to this process.
process.on('disconnect', () => process.exit(0))
