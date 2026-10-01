import type { LlmCallRecord } from '@milibot/agent'
import {
  EmbeddingError,
  type EmbeddingProvider,
  type EmbeddingSetting,
  type EmbeddingUsage,
  findApiEmbeddingModel,
  findLocalEmbeddingLevel,
  Int8VectorIndex,
  localSettingSpaceKey,
  type ModelDownloadProgress,
  parseEmbeddingSetting,
  type QuantizedVector,
  quantizeInt8,
  type VectorSearchHit,
} from '@milibot/agent/embeddings'
import { KNOWLEDGE_SETTING_KEYS, type KnowledgeIndexState, type LogFn } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { sha256 } from '../../util/hash'

/** The space searches use, and the setting that produces its query vectors. */
export const ACTIVE_SPACE_KEY = 'knowledge.active_space'
const BATCH = 32
const RETRY_MS = 5 * 60_000

interface ActiveSpace {
  space: string
  setting: EmbeddingSetting
}

export interface EmbeddingServiceDeps {
  chunks: ChunkCorpus
  getSetting: <T>(key: string, fallback: T) => T
  setSetting: (key: string, value: unknown) => void
  /** Builds the provider of a setting; `onProgress` reports local model downloads. */
  createProvider: (
    setting: EmbeddingSetting,
    onProgress: (progress: ModelDownloadProgress) => void,
  ) => Promise<EmbeddingProvider>
  /** Longest input registered for an API embedding model (Providers and models), null when unknown. */
  apiMaxInputTokens?: (providerId: string, model: string) => number | null
  /** Cost of API embedding calls (`llm_calls`, purpose `embedding`). */
  recordUsage?: (setting: EmbeddingSetting, usage: EmbeddingUsage) => void
  now: () => number
  log: LogFn
}

/**
 * Items embedded in the knowledge base's vector space by id (document, plan and board summaries), tracked by the
 * sha256 of their text: indexed with the chunks, reindexed with them when the model changes, dropped from the
 * spaces that go away.
 */
export interface VectorCorpus {
  name: string
  /** Every item that should have a vector, with the text to embed. */
  items(): Array<{ id: string; text: string }>
  /** sha256 of the text each stored vector of `space` was made from. */
  shas(space: string): Map<string, string>
  save(id: string, space: string, dims: number, vector: QuantizedVector, sha: string): void
  each(space: string, visit: (id: string, vector: QuantizedVector) => void): void
  deleteSpacesExcept(keep: string[]): void
}

/**
 * The chunks of the documents: numeric ids grouped by document, vectors kept per chunk (a chunk whose text did
 * not change keeps its vector), the ones still missing found by the corpus itself. `summaries` holds a vector per
 * document, embedded right after the document's chunks.
 */
export interface ChunkCorpus {
  summaries: VectorCorpus
  total(): number
  /** Chunks without a vector in `space`: of one document, or of every document still indexed. */
  pendingCount(space: string, docId?: string): number
  pending(
    space: string,
    options: { docId?: string; limit: number },
  ): Array<{ id: number; docId: string; text: string }>
  save(space: string, dims: number, rows: Array<{ id: number; vector: QuantizedVector }>): void
  vectors(ids: number[], space: string): Map<number, QuantizedVector>
  each(space: string, visit: (id: number, docId: string, vector: QuantizedVector) => void): void
  vectorCount(space: string): number
  exists(docId: string): boolean
  /** Removes the chunk vectors of every space not in `keep`; returns how many. */
  deleteSpacesExcept(keep: string[]): number
}

interface ChunkIndex {
  index: Int8VectorIndex<number>
  docOf: Map<number, string>
}

export interface EmbeddingState {
  state: KnowledgeIndexState
  activeSpace: string | null
  targetSpace: string | null
  download: { modelId: string; progress: number; loadedBytes: number; totalBytes: number } | null
  error: { code: string; message: string } | null
}

function settingKey(setting: EmbeddingSetting): string {
  return JSON.stringify(setting)
}

/**
 * The workspace's vector space: the embedding providers (the chosen model and, while reindexing, the previous one
 * whose space searches still use), the document chunks and the registered corpora with their in-memory int8
 * indexes per space, background (re)indexing, download progress and errors. Without a usable model everything
 * falls back to full-text search.
 */
export class EmbeddingService {
  private readonly providers = new Map<string, Promise<EmbeddingProvider>>()
  private readonly chunkIndexes = new Map<string, ChunkIndex>()
  private readonly corpora = new Map<string, VectorCorpus>()
  /** `<corpus>:<space>` → loaded index. */
  private readonly corpusIndexes = new Map<string, { space: string; index: Int8VectorIndex<string> }>()
  private phase: 'idle' | 'downloading' | 'loading' | 'indexing' = 'idle'
  private download: EmbeddingState['download'] = null
  private error: EmbeddingState['error'] = null
  private unavailableUntil = 0
  private retryTimer: NodeJS.Timeout | null = null
  private backfilling: Promise<void> | null = null
  private rerun = false
  private stopped = false
  private readonly abort = new AbortController()
  /** Space key of the chosen setting once its provider was built (API spaces need the output size). */
  private targetKey: { setting: string; space: string } | null = null

  private readonly statusListeners = new Set<() => void>()

  constructor(private readonly deps: EmbeddingServiceDeps) {
    this.addCorpus(deps.chunks.summaries)
  }

  /** `listener` runs whenever the index state (phase, download, error) changes. */
  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private statusChanged(): void {
    for (const listener of this.statusListeners) listener()
  }

  configured(): EmbeddingSetting {
    return parseEmbeddingSetting(this.deps.getSetting<unknown>(KNOWLEDGE_SETTING_KEYS.embedding, null))
  }

  active(): ActiveSpace | null {
    const value = this.deps.getSetting<ActiveSpace | null>(ACTIVE_SPACE_KEY, null)
    return value && typeof value.space === 'string'
      ? { space: value.space, setting: parseEmbeddingSetting(value.setting) }
      : null
  }

  /** Space of the chosen model, when known without building it (local) or already built (API). */
  targetSpace(): string | null {
    const setting = this.configured()
    if (this.targetKey?.setting === settingKey(setting)) return this.targetKey.space
    return localSettingSpaceKey(setting)
  }

  status(): EmbeddingState {
    const active = this.active()?.space ?? null
    const target = this.targetSpace()
    const reindexing = active !== null && target !== null && target !== active
    const state: KnowledgeIndexState =
      this.error && this.phase === 'idle'
        ? 'unavailable'
        : this.phase === 'indexing' && reindexing
          ? 'reindexing'
          : this.phase
    return {
      state,
      activeSpace: active,
      targetSpace: target !== active ? target : null,
      download: this.phase === 'downloading' ? this.download : null,
      error: this.error,
    }
  }

  stop(): void {
    this.stopped = true
    this.abort.abort()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const promise of this.providers.values())
      void promise.then((p) => p.dispose?.()).catch(() => undefined)
    this.providers.clear()
  }

  async whenIdle(): Promise<void> {
    while (this.backfilling) await this.backfilling.catch(() => undefined)
  }

  private setPhase(phase: EmbeddingService['phase']): void {
    if (this.phase === phase) return
    this.phase = phase
    if (phase !== 'downloading') this.download = null
    this.statusChanged()
  }

  private fail(err: unknown): void {
    const code = err instanceof EmbeddingError ? err.code : 'provider_error'
    if (code === 'aborted' && this.stopped) return
    const message = errorMessage(err)
    this.error = { code, message: message.slice(0, 500) }
    this.unavailableUntil = this.deps.now() + RETRY_MS
    this.deps.log('warn', 'knowledge embeddings unavailable', { code, err: message })
    this.phase = 'idle'
    this.download = null
    this.statusChanged()
    if (!this.retryTimer && !this.stopped) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.error = null
        this.schedule()
      }, RETRY_MS)
      this.retryTimer.unref()
    }
  }

  private ok(): void {
    if (!this.error) return
    this.error = null
    this.unavailableUntil = 0
    this.statusChanged()
  }

  /** Clears an error and tries the model again now. */
  retry(): void {
    this.error = null
    this.unavailableUntil = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.statusChanged()
    this.schedule()
  }

  private provider(setting: EmbeddingSetting): Promise<EmbeddingProvider> {
    const key = settingKey(setting)
    let promise = this.providers.get(key)
    if (!promise) {
      promise = this.deps
        .createProvider(setting, (progress) => this.onProgress(progress))
        .then((provider) => {
          if (key === settingKey(this.configured())) this.targetKey = { setting: key, space: provider.key }
          return provider
        })
      this.providers.set(key, promise)
      promise.catch(() => this.providers.delete(key))
    }
    return promise
  }

  private onProgress(progress: ModelDownloadProgress): void {
    if (progress.done) return
    this.phase = 'downloading'
    this.download = {
      modelId: progress.modelId,
      progress: progress.progress,
      loadedBytes: progress.loadedBytes,
      totalBytes: progress.totalBytes,
    }
    this.statusChanged()
  }

  /** Downloads/loads a local model before embedding, so the status can say which one is happening. */
  private async warm(provider: EmbeddingProvider): Promise<void> {
    const local = provider as EmbeddingProvider & {
      isDownloaded?: () => boolean
      prepare?: (signal?: AbortSignal) => Promise<unknown>
      loaded?: boolean
    }
    if (!local.prepare || local.loaded) return
    this.setPhase(local.isDownloaded?.() === false ? 'downloading' : 'loading')
    await local.prepare(this.abort.signal)
  }

  private async embed(
    setting: EmbeddingSetting,
    provider: EmbeddingProvider,
    texts: string[],
    kind: 'query' | 'document',
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    const result = await provider.embed(texts, kind, signal ?? this.abort.signal)
    if (result.usage?.costUsd !== undefined) this.deps.recordUsage?.(setting, result.usage)
    return result.vectors
  }

  private adoptIfEmpty(setting: EmbeddingSetting, space: string): void {
    const active = this.active()
    if (active?.space === space) return
    if (active && this.deps.chunks.vectorCount(active.space) > 0) return
    this.switchTo(setting, space)
  }

  private switchTo(setting: EmbeddingSetting, space: string): void {
    const previous = this.active()?.space ?? null
    this.deps.setSetting(ACTIVE_SPACE_KEY, { space, setting })
    const removed = this.deps.chunks.deleteSpacesExcept([space])
    for (const corpus of this.corpora.values()) corpus.deleteSpacesExcept([space])
    for (const key of [...this.chunkIndexes.keys()]) if (key !== space) this.chunkIndexes.delete(key)
    for (const [key, loaded] of [...this.corpusIndexes])
      if (loaded.space !== space) this.corpusIndexes.delete(key)
    for (const [key, promise] of this.providers) {
      if (key !== settingKey(setting)) {
        this.providers.delete(key)
        void promise.then((p) => p.dispose?.()).catch(() => undefined)
      }
    }
    if (previous !== space)
      this.deps.log('info', 'knowledge index switched', { from: previous, to: space, removed })
    this.statusChanged()
  }

  /**
   * Embeds the chunks (and the summary) of one document in the chosen model's space. Returns false when
   * the model is unavailable (the document is then found by text only until the backfill catches up).
   */
  async embedDocument(docId: string, onProgress?: (done: number, total: number) => void): Promise<boolean> {
    if (this.stopped || this.deps.now() < this.unavailableUntil) return false
    const setting = this.configured()
    try {
      const provider = await this.provider(setting)
      await this.warm(provider)
      this.setPhase('indexing')
      const space = provider.key
      const chunks = this.deps.chunks
      const total = chunks.pendingCount(space, docId)
      let done = 0
      for (;;) {
        if (this.stopped || !chunks.exists(docId)) break
        const batch = chunks.pending(space, { docId, limit: BATCH })
        if (!batch.length) break
        await this.embedChunks(setting, provider, batch)
        done += batch.length
        onProgress?.(Math.min(done, total), total)
      }
      await this.embedCorpus(setting, provider, chunks.summaries, [docId])
      this.ok()
      this.adoptIfEmpty(setting, space)
      return true
    } catch (err) {
      this.fail(err)
      return false
    } finally {
      if (!this.backfilling) this.setPhase('idle')
    }
  }

  private async embedChunks(
    setting: EmbeddingSetting,
    provider: EmbeddingProvider,
    chunks: Array<{ id: number; docId: string; text: string }>,
  ) {
    const vectors = await this.embed(
      setting,
      provider,
      chunks.map((c) => c.text),
      'document',
    )
    const rows = chunks.map((c, i) => ({ id: c.id, vector: quantizeInt8(vectors[i] as Float32Array) }))
    this.deps.chunks.save(provider.key, provider.dimensions, rows)
    const loaded = this.chunkIndexes.get(provider.key)
    if (loaded) {
      rows.forEach((r, i) => {
        loaded.index.addQuantized(r.id, r.vector.data, r.vector.scale)
        loaded.docOf.set(r.id, (chunks[i] as { docId: string }).docId)
      })
    }
  }

  private pendingItems(corpus: VectorCorpus, space: string, only?: string[]) {
    const current = corpus.shas(space)
    return corpus
      .items()
      .filter((item) => !only || only.includes(item.id))
      .map((item) => ({ ...item, sha: sha256(item.text) }))
      .filter((item) => current.get(item.id) !== item.sha)
  }

  private async embedCorpus(
    setting: EmbeddingSetting,
    provider: EmbeddingProvider,
    corpus: VectorCorpus,
    only?: string[],
  ): Promise<void> {
    const wanted = this.pendingItems(corpus, provider.key, only)
    for (let i = 0; i < wanted.length; i += BATCH) {
      if (this.stopped) return
      const batch = wanted.slice(i, i + BATCH)
      const vectors = await this.embed(
        setting,
        provider,
        batch.map((item) => item.text),
        'document',
      )
      batch.forEach((item, j) => {
        const vector = quantizeInt8(vectors[j] as Float32Array)
        corpus.save(item.id, provider.key, provider.dimensions, vector, item.sha)
        this.corpusIndexes
          .get(`${corpus.name}:${provider.key}`)
          ?.index.addQuantized(item.id, vector.data, vector.scale)
      })
    }
  }

  /** Registers another corpus in the vector space (its items are embedded by the next backfill). */
  addCorpus(corpus: VectorCorpus): void {
    this.corpora.set(corpus.name, corpus)
  }

  /** Embeds new or changed items of a corpus now (when a model is available). */
  async refreshCorpus(name: string, ids: string[]): Promise<void> {
    const corpus = this.corpora.get(name)
    if (!corpus || this.stopped || this.deps.now() < this.unavailableUntil) return
    const setting = this.configured()
    try {
      const provider = await this.provider(setting)
      if (!this.pendingItems(corpus, provider.key, ids).length) return
      await this.warm(provider)
      await this.embedCorpus(setting, provider, corpus, ids)
      this.ok()
      this.adoptIfEmpty(setting, provider.key)
    } catch (err) {
      this.fail(err)
    } finally {
      if (!this.backfilling) this.setPhase('idle')
    }
  }

  forgetCorpusItem(name: string, id: string): void {
    for (const [key, loaded] of this.corpusIndexes) if (key.startsWith(`${name}:`)) loaded.index.remove(id)
  }

  searchCorpus(
    name: string,
    query: { space: string; vector: Float32Array },
    topK: number,
    allowed: Set<string> | null,
  ): VectorSearchHit<string>[] {
    const corpus = this.corpora.get(name)
    if (!corpus) return []
    const key = `${name}:${query.space}`
    let loaded = this.corpusIndexes.get(key)
    if (!loaded) {
      let index: Int8VectorIndex<string> | null = null
      corpus.each(query.space, (id, vector) => {
        index ??= new Int8VectorIndex<string>(vector.data.length, 256)
        index.addQuantized(id, vector.data, vector.scale)
      })
      if (!index) return []
      loaded = { space: query.space, index }
      this.corpusIndexes.set(key, loaded)
    }
    if (loaded.index.dimensions !== query.vector.length) return []
    return loaded.index.search(query.vector, topK, allowed ? (id) => allowed.has(id) : undefined)
  }

  /** Runs the background indexing (model change, gaps left by failures) unless it is already running. */
  schedule(): void {
    if (this.stopped) return
    if (this.backfilling) {
      this.rerun = true
      return
    }
    this.backfilling = (async () => {
      do {
        this.rerun = false
        await this.backfill()
      } while (this.rerun && !this.stopped)
    })().finally(() => {
      this.backfilling = null
      if (!this.stopped) this.setPhase('idle')
    })
  }

  private async backfill(): Promise<void> {
    if (this.deps.now() < this.unavailableUntil) return
    const chunks = this.deps.chunks
    const setting = this.configured()
    const corpora = [...this.corpora.values()]
    const hasWork = chunks.total() > 0 || corpora.some((c) => c.items().length > 0)
    if (!hasWork) return
    try {
      const provider = await this.provider(setting)
      const space = provider.key
      const pending = chunks.pendingCount(space)
      const corpusPending = corpora.some((c) => this.pendingItems(c, space).length > 0)
      if (pending > 0 || corpusPending) {
        await this.warm(provider)
        this.setPhase('indexing')
        for (;;) {
          if (this.stopped) return
          const batch = chunks.pending(space, { limit: BATCH })
          if (!batch.length) break
          await this.embedChunks(setting, provider, batch)
          this.statusChanged()
        }
        for (const corpus of corpora) await this.embedCorpus(setting, provider, corpus)
      }
      this.ok()
      if (this.active()?.space !== space && chunks.pendingCount(space) === 0) this.switchTo(setting, space)
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * Query vector in the active space. `loadModel: false` gives up (null) instead of downloading or
   * starting a model that is not loaded (per-turn suggestions must not wait for it).
   */
  async queryVector(
    text: string,
    options: { timeoutMs: number; loadModel: boolean },
  ): Promise<{ space: string; vector: Float32Array } | null> {
    const active = this.active()
    if (!active || this.stopped) return null
    if (
      this.deps.now() < this.unavailableUntil &&
      settingKey(active.setting) === settingKey(this.configured())
    )
      return null
    try {
      const provider = await this.provider(active.setting)
      if (provider.key !== active.space) return null
      const local = provider as EmbeddingProvider & { isDownloaded?: () => boolean }
      if (!options.loadModel && local.isDownloaded?.() === false) return null
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(options.timeoutMs)])
      const [vector] = await this.embed(active.setting, provider, [text], 'query', signal)
      return vector ? { space: active.space, vector } : null
    } catch (err) {
      this.deps.log('warn', 'knowledge query embedding failed', { err: errorMessage(err) })
      return null
    }
  }

  private chunkIndex(space: string): ChunkIndex | null {
    let loaded = this.chunkIndexes.get(space)
    if (loaded) return loaded
    let index: Int8VectorIndex<number> | null = null
    const docOf = new Map<number, string>()
    this.deps.chunks.each(space, (chunkId, docId, vector) => {
      index ??= new Int8VectorIndex<number>(vector.data.length, 1024)
      index.addQuantized(chunkId, vector.data, vector.scale)
      docOf.set(chunkId, docId)
    })
    if (!index) return null
    loaded = { index, docOf }
    this.chunkIndexes.set(space, loaded)
    return loaded
  }

  searchChunks(
    query: { space: string; vector: Float32Array },
    topK: number,
    allowedDocs: Set<string> | null,
  ): Array<VectorSearchHit<number> & { docId: string }> {
    const loaded = this.chunkIndex(query.space)
    if (!loaded || loaded.index.dimensions !== query.vector.length) return []
    return loaded.index
      .search(
        query.vector,
        topK,
        allowedDocs ? (id) => allowedDocs.has(loaded.docOf.get(id) ?? '') : undefined,
      )
      .map((hit) => ({ ...hit, docId: loaded.docOf.get(hit.id) ?? '' }))
  }

  /** Chunks deleted (document removed or rechunked): out of the in-memory indexes. */
  forgetChunks(ids: number[]): void {
    for (const loaded of this.chunkIndexes.values()) {
      for (const id of ids) {
        loaded.index.remove(id)
        loaded.docOf.delete(id)
      }
    }
  }

  /** New chunks that got stored vectors (reused by hash) go into the loaded indexes. */
  addStoredChunks(chunks: Array<{ id: number; docId: string }>): void {
    for (const [space, loaded] of this.chunkIndexes) {
      const vectors = this.deps.chunks.vectors(
        chunks.map((c) => c.id),
        space,
      )
      for (const c of chunks) {
        const v = vectors.get(c.id)
        if (!v) continue
        loaded.index.addQuantized(c.id, v.data, v.scale)
        loaded.docOf.set(c.id, c.docId)
      }
    }
  }

  /** Chunk size for new chunks: what the chosen model reads without truncating. */
  maxInputTokens(): number {
    const setting = this.configured()
    if (setting.provider === 'local')
      return findLocalEmbeddingLevel(setting.family, setting.level)?.model.maxInputTokens ?? 512
    return (
      this.deps.apiMaxInputTokens?.(setting.providerId, setting.model) ??
      findApiEmbeddingModel(setting.model)?.maxInputTokens ??
      8192
    )
  }
}

export function recordEmbeddingCost(
  recordLlmCall: (record: LlmCallRecord) => string,
  setting: EmbeddingSetting,
  usage: { tokens: number; costUsd?: number },
): void {
  if (setting.provider !== 'api') return
  recordLlmCall({
    botId: null,
    conversationId: null,
    turnId: null,
    purpose: 'embedding',
    providerId: setting.providerId,
    providerType: 'openai_compatible',
    model: setting.model,
    request: null,
    response: null,
    usage: {
      inputTokens: usage.tokens,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: usage.costUsd ?? null,
      costSource: usage.costUsd === undefined ? 'unknown' : 'provider',
    },
    contextComposition: null,
    stopReason: null,
    generationId: null,
    latencyMs: null,
    error: null,
  })
}
