import { type ChildProcess, fork } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import type { Socket } from 'node:net'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type LocalEmbeddingLevel, type LocalEmbeddingModel, localEmbeddingSpaceKey } from './catalog'
import { EmbedQueue } from './embed-queue'
import type { EmbeddingWorkerConfig, EmbeddingWorkerRequest, EmbeddingWorkerResponse } from './local-protocol'
import type { EmbeddingKind, EmbeddingProvider, EmbeddingResult, ModelDownloadProgress } from './types'
import { EmbeddingError } from './types'
import { truncateMrl } from './vector'

export const DEFAULT_EMBEDDING_IDLE_UNLOAD_MS = 5 * 60_000
/** Waiting queries merged into one worker run (they are one short text each). */
const MAX_QUERY_TEXTS = 32

export interface LocalEmbeddingOptions {
  /** Model cache shared by all workspaces (the daemon passes `<dataRoot>/models`). */
  cacheDir: string
  /** onnxruntime intra-op threads (default: 4, at most half of the cores). */
  threads?: number
  /** The worker process (and the model's memory) goes away after this long without requests. */
  idleUnloadMs?: number
  /** Download progress of the model files (also reported when another provider triggered the download). */
  onProgress?: (progress: ModelDownloadProgress) => void
  /** Worker script; default: next to this module (sources) or `embedding-worker.js` next to the bundle. */
  workerUrl?: URL
  /** Hugging Face mirror (tests). */
  remoteHost?: string
}

export function defaultEmbeddingThreads(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
}

/**
 * Sources run the `.ts` worker (tsx's loader is inherited through `execArgv`); the daemon bundle ships
 * it as `dist/embedding-worker.js`, next to `runtime-main.js`.
 */
export function defaultEmbeddingWorkerUrl(): URL {
  return import.meta.url.endsWith('.ts')
    ? new URL('./local-worker.ts', import.meta.url)
    : new URL('./embedding-worker.js', import.meta.url)
}

export function isLocalModelDownloaded(cacheDir: string, model: LocalEmbeddingModel): boolean {
  return model.files.every((file) => existsSync(join(cacheDir, model.repo, file)))
}

/** Bytes of the model files already on disk (0 when nothing was downloaded). */
export function localModelDiskBytes(cacheDir: string, model: LocalEmbeddingModel): number {
  return model.files.reduce((sum, file) => {
    const path = join(cacheDir, model.repo, file)
    return sum + (existsSync(path) ? statSync(path).size : 0)
  }, 0)
}

interface Pending {
  resolve: (value: EmbeddingWorkerResponse) => void
  reject: (err: EmbeddingError) => void
}

export interface LocalModelHostOptions {
  cacheDir: string
  threads: number
  idleUnloadMs: number
  workerUrl: URL
  remoteHost?: string
  /** Process start/stop/unload (with the worker's memory). */
  log?: (level: 'info' | 'warn', message: string, extra: Record<string, unknown>) => void
}

export interface HostEmbedOptions {
  signal?: AbortSignal
  /** Queries jump ahead of document batches. Default `document`. */
  kind?: EmbeddingKind
  /** Fairness key between callers (workspaces) of a shared host. */
  client?: string
}

interface EmbedJob {
  client: string
  kind: EmbeddingKind
  texts: string[]
  settled: boolean
  run: EmbedRun | null
  resolve: (value: { vectors: Float32Array[]; tokens: number }) => void
  reject: (err: EmbeddingError) => void
}

interface EmbedRun {
  jobs: EmbedJob[]
  controller: AbortController
}

export type ModelUnloadReason = 'idle' | 'released' | 'shutdown'

/** Flags of this process that must not reach the worker (a second inspector would fight for the port). */
function workerExecArgv(): string[] {
  return process.execArgv.filter((arg) => !/^--(inspect|debug)/.test(arg))
}

/**
 * One worker process running one model, shared by every provider of that model (EmbeddingGemma's three
 * levels use the same weights; in the daemon, by every workspace through the supervisor). Started on the
 * first request, stopped after `idleUnloadMs` without requests or when the last provider is disposed;
 * stopping it gives all of the model's memory back (a worker_thread would not: onnxruntime's allocations
 * stay in the footprint). Embedding requests wait in an `EmbedQueue` and run one at a time.
 */
export class LocalModelHost {
  private child: ChildProcess | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: NodeJS.Timeout | null = null
  private refs = 0
  private stderrTail = ''
  private readonly listeners = new Set<(progress: ModelDownloadProgress) => void>()
  private readonly queue = new EmbedQueue<EmbedJob>()
  private run: EmbedRun | null = null
  /** Set once the model is loaded in the current worker. */
  loaded = false
  /** Worker processes started so far (tests, diagnostics). */
  spawnCount = 0

  constructor(
    readonly model: LocalEmbeddingModel,
    private readonly options: LocalModelHostOptions,
  ) {}

  get threads(): number {
    return this.options.threads
  }

  get running(): boolean {
    return this.child !== null
  }

  /** Worker pid while running (tests, diagnostics). */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  retain(onProgress?: (progress: ModelDownloadProgress) => void): () => Promise<void> {
    this.refs++
    const removeListener = onProgress ? this.onProgress(onProgress) : () => undefined
    let released = false
    return async () => {
      if (released) return
      released = true
      removeListener()
      if (--this.refs <= 0) await this.unload('released')
    }
  }

  /** Download progress without keeping the model loaded (the idle timeout still applies). */
  onProgress(listener: (progress: ModelDownloadProgress) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Downloads (if needed) and loads the model. */
  async load(signal?: AbortSignal): Promise<{ loadMs: number; downloaded: boolean }> {
    const res = await this.request({ type: 'load', id: 0 }, signal)
    if (res.type !== 'loaded') throw new EmbeddingError('inference_failed', 'unexpected worker reply')
    return { loadMs: res.loadMs, downloaded: res.downloaded }
  }

  /** Native-size unit vectors; `texts` already carry the model's prefix. */
  embed(
    texts: string[],
    options: HostEmbedOptions = {},
  ): Promise<{ vectors: Float32Array[]; tokens: number }> {
    const { signal } = options
    if (texts.length === 0) return Promise.resolve({ vectors: [], tokens: 0 })
    if (signal?.aborted) return Promise.reject(new EmbeddingError('aborted', 'embedding aborted'))
    return new Promise((resolve, reject) => {
      const onAbort = () => this.abortJob(job)
      const job: EmbedJob = {
        client: options.client ?? 'local',
        kind: options.kind ?? 'document',
        texts,
        settled: false,
        run: null,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.clearIdle()
      this.queue.push(job)
      this.pump()
    })
  }

  /** Requests waiting for their turn (tests, diagnostics). */
  get queued(): number {
    return this.queue.size
  }

  private settle(
    job: EmbedJob,
    outcome: { value: { vectors: Float32Array[]; tokens: number } } | { error: EmbeddingError },
  ): void {
    if (job.settled) return
    job.settled = true
    if ('error' in outcome) job.reject(outcome.error)
    else job.resolve(outcome.value)
  }

  private abortJob(job: EmbedJob): void {
    if (job.settled) return
    const queued = this.queue.remove(job)
    this.settle(job, { error: new EmbeddingError('aborted', 'embedding aborted') })
    if (queued) {
      this.scheduleIdle()
      return
    }
    // A merged run keeps going for the other callers.
    if (job.run && job.run.jobs.every((j) => j.settled)) job.run.controller.abort()
  }

  private pump(): void {
    if (this.run) return
    const jobs = this.queue.next(MAX_QUERY_TEXTS)
    if (jobs.length === 0) {
      this.scheduleIdle()
      return
    }
    const run: EmbedRun = { jobs, controller: new AbortController() }
    this.run = run
    for (const job of jobs) job.run = run
    Promise.resolve()
      .then(() =>
        this.request({ type: 'embed', id: 0, texts: jobs.flatMap((j) => j.texts) }, run.controller.signal),
      )
      .then((res) => {
        if (res.type !== 'result') throw new EmbeddingError('inference_failed', 'unexpected worker reply')
        let offset = 0
        for (const job of jobs) {
          const end = offset + job.texts.length
          const tokens = res.counts
            ? res.counts.slice(offset, end).reduce((a, b) => a + b, 0)
            : Math.round((res.tokens * job.texts.length) / res.vectors.length)
          this.settle(job, { value: { vectors: res.vectors.slice(offset, end), tokens } })
          offset = end
        }
      })
      .catch((err: unknown) => {
        const error =
          err instanceof EmbeddingError ? err : new EmbeddingError('inference_failed', (err as Error).message)
        for (const job of jobs) this.settle(job, { error })
      })
      .finally(() => {
        if (this.run === run) this.run = null
        this.pump()
      })
  }

  /** Memory of the worker process; null when it is not running. */
  async stats(): Promise<{ rssBytes: number; peakRssBytes: number } | null> {
    if (!this.child) return null
    const res = await this.request({ type: 'stats', id: 0 })
    if (res.type !== 'stats') throw new EmbeddingError('inference_failed', 'unexpected worker reply')
    return { rssBytes: res.rssBytes, peakRssBytes: res.peakRssBytes }
  }

  private busy(): boolean {
    return this.pending.size > 0 || this.run !== null || this.queue.size > 0
  }

  /** Stops the worker (a download in progress stops too); pending and queued requests fail with `aborted`. */
  async unload(reason: ModelUnloadReason = 'released'): Promise<void> {
    this.clearIdle()
    const log = this.options.log
    const pid = this.child?.pid ?? null
    const memory = log && this.child ? await this.memoryForLog() : null
    if (reason === 'idle' && this.busy()) {
      this.scheduleIdle()
      return
    }
    this.clearIdle()
    const child = this.child
    this.child = null
    this.loaded = false
    const aborted = new EmbeddingError('aborted', 'embedding model unloaded')
    for (const job of this.queue.drain()) this.settle(job, { error: aborted })
    this.failAll(aborted)
    if (child && pid !== null) {
      log?.('info', 'embedding model unloaded', { model: this.model.repo, workerPid: pid, reason, ...memory })
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3000)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  private async memoryForLog(): Promise<Record<string, number> | null> {
    const stats = await Promise.race([
      this.stats().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000).unref()),
    ])
    if (!stats) return null
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))
    return { rssMb: mb(stats.rssBytes), peakRssMb: mb(stats.peakRssBytes) }
  }

  private request(message: EmbeddingWorkerRequest, signal?: AbortSignal): Promise<EmbeddingWorkerResponse> {
    if (signal?.aborted) return Promise.reject(new EmbeddingError('aborted', 'embedding aborted'))
    const child = this.ensureChild()
    this.clearIdle()
    // Referenced only while a request is pending, so an idle model never keeps the process alive.
    child.ref()
    child.channel?.ref()
    const id = this.nextId++
    return new Promise<EmbeddingWorkerResponse>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return
        if (child.connected) child.send({ type: 'cancel', id } satisfies EmbeddingWorkerRequest)
        reject(new EmbeddingError('aborted', 'embedding aborted'))
        this.scheduleIdle()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      this.pending.set(id, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
      })
      child.send({ ...message, id })
    })
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child
    const config: EmbeddingWorkerConfig = {
      cacheDir: this.options.cacheDir,
      model: this.model,
      threads: this.options.threads,
      ...(this.options.remoteHost ? { remoteHost: this.options.remoteHost } : {}),
    }
    const child = fork(fileURLToPath(this.options.workerUrl), [JSON.stringify(config)], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: workerExecArgv(),
      windowsHide: true,
    })
    this.stderrTail = ''
    this.spawnCount++
    this.options.log?.('info', 'embedding model process started', {
      model: this.model.repo,
      dtype: this.model.dtype,
      workerPid: child.pid,
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    ;(child.stderr as Socket | null)?.unref()
    child.on('message', (message: EmbeddingWorkerResponse) => this.onMessage(message))
    child.on('error', (err) => this.lost(child, `embedding worker failed: ${err.message}`))
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim().split('\n').slice(-5).join('\n')
      this.lost(child, `embedding worker exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ''}`)
    })
    this.child = child
    return child
  }

  /** The worker died: requests sent to it fail; queued ones start a new worker. */
  private lost(child: ChildProcess, reason: string): void {
    if (this.child !== child) return
    const code = this.loaded ? 'inference_failed' : 'model_load_failed'
    this.child = null
    this.loaded = false
    this.clearIdle()
    this.options.log?.('warn', 'embedding model process exited', {
      model: this.model.repo,
      workerPid: child.pid,
      reason,
    })
    this.failAll(new EmbeddingError(code, reason))
  }

  private onMessage(message: EmbeddingWorkerResponse): void {
    if (message.type === 'progress') {
      for (const listener of this.listeners) listener(message.progress)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.type === 'error') {
      pending.reject(new EmbeddingError(message.code, message.message))
    } else {
      if (message.type !== 'stats') this.loaded = true
      pending.resolve(message)
    }
    this.scheduleIdle()
  }

  private failAll(err: EmbeddingError): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) p.reject(err)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private scheduleIdle(): void {
    if (this.busy() || !this.child) return
    this.child.unref()
    this.child.channel?.unref()
    this.clearIdle()
    this.idleTimer = setTimeout(() => void this.unload('idle'), this.options.idleUnloadMs)
    this.idleTimer.unref()
  }
}

/** Embeds with a catalog level on a host: the model's prefix, then MRL truncation below the native size. */
export async function embedWithLevel(
  host: LocalModelHost,
  level: LocalEmbeddingLevel,
  texts: string[],
  kind: EmbeddingKind,
  options: { signal?: AbortSignal; client?: string } = {},
): Promise<EmbeddingResult> {
  const { model } = level
  const prefix = kind === 'query' ? model.queryPrefix : model.documentPrefix
  const { vectors, tokens } = await host.embed(
    texts.map((t) => prefix + t),
    { ...options, kind },
  )
  return {
    vectors:
      level.dimensions < model.nativeDimensions
        ? vectors.map((v) => truncateMrl(v, level.dimensions))
        : vectors,
    usage: { tokens },
  }
}

const hosts = new Map<string, LocalModelHost>()

function hostFor(model: LocalEmbeddingModel, options: LocalEmbeddingOptions): LocalModelHost {
  const key = `${options.cacheDir}\n${model.repo}\n${model.dtype}`
  let host = hosts.get(key)
  if (!host) {
    host = new LocalModelHost(model, {
      cacheDir: options.cacheDir,
      threads: options.threads ?? defaultEmbeddingThreads(),
      idleUnloadMs: options.idleUnloadMs ?? DEFAULT_EMBEDDING_IDLE_UNLOAD_MS,
      workerUrl: options.workerUrl ?? defaultEmbeddingWorkerUrl(),
      ...(options.remoteHost ? { remoteHost: options.remoteHost } : {}),
    })
    hosts.set(key, host)
  }
  return host
}

/** A level of the local catalog run by a worker process of this process (see `LocalModelHost`). */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly key: string
  readonly dimensions: number
  readonly maxInputTokens: number
  readonly host: LocalModelHost
  private readonly release: () => Promise<void>

  constructor(
    readonly level: LocalEmbeddingLevel,
    private readonly options: LocalEmbeddingOptions,
  ) {
    this.key = localEmbeddingSpaceKey(level)
    this.dimensions = level.dimensions
    this.maxInputTokens = level.model.maxInputTokens
    this.host = hostFor(level.model, options)
    this.release = this.host.retain(options.onProgress)
  }

  isDownloaded(): boolean {
    return isLocalModelDownloaded(this.options.cacheDir, this.level.model)
  }

  /** Downloads and loads the model ahead of the first `embed` (progress goes to `onProgress`). */
  prepare(signal?: AbortSignal): Promise<{ loadMs: number; downloaded: boolean }> {
    return this.host.load(signal)
  }

  get loaded(): boolean {
    return this.host.loaded
  }

  embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<EmbeddingResult> {
    return embedWithLevel(this.host, this.level, texts, kind, signal ? { signal } : {})
  }

  dispose(): Promise<void> {
    return this.release()
  }
}
