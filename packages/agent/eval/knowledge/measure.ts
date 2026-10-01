/**
 * Measures one local model: download, load time, memory of the worker process, throughput on the
 * corpus passages and on ~600-token chunks, query latency, and retrieval quality for each catalog
 * level of the model (vector only, and hybrid with BM25 through RRF).
 */
import {
  type LocalEmbeddingLevel,
  localEmbeddingLevels,
  localEmbeddingSpaceKey,
  type LocalModelDtype,
  onnxModelFiles,
} from '../../src/embeddings/catalog'
import {
  isLocalModelDownloaded,
  LocalEmbeddingProvider,
  localModelDiskBytes,
} from '../../src/embeddings/local'
import { lexicalQueryWeight, reciprocalRankFusion } from '../../src/embeddings/rrf'
import { truncateMrl } from '../../src/embeddings/vector'
import { Int8VectorIndex } from '../../src/embeddings/vector-index'
import { Bm25 } from './bm25'
import { PASSAGES, QUERIES } from './corpus'
import { evaluate, type MetricsByKind } from './metrics'

interface LevelResult {
  family: string
  level: string
  key: string
  dimensions: number
  vector: MetricsByKind
  /** RRF (k = 60) of BM25 top 30 and vector top 30, equal weights (the product's search). */
  hybrid: MetricsByKind
  /** Same with BM25 at half weight. */
  hybridHalfBm25: MetricsByKind
  /** Same with BM25 at a quarter weight. */
  hybridQuarterBm25: MetricsByKind
  /**
   * Score fusion instead of ranks: 0.8 × cosine + 0.2 × BM25 / best BM25 of the query, over the union
   * of both top 30 lists.
   */
  hybridScore: MetricsByKind
  /** RRF with BM25 at full weight only for identifier-like queries (`lexicalQueryWeight`), else 0.1. */
  hybridAdaptive: MetricsByKind
}

export interface ModelMeasurement {
  repo: string
  dtype: LocalModelDtype
  threads: number
  downloadBytes: number
  /** Null when the model was already in the cache. */
  downloadMs: number | null
  loadMs: number
  /** Worker process after loading, before any inference. */
  loadedRssMb: number
  /** Worker process peak over load + all the embedding below. */
  peakRssMb: number
  passagesPerSecond: number
  passageTokens: number
  chunksPerSecond: number
  chunkTokens: number
  queryMs: number
  levels: LevelResult[]
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)

/** ~600 estimated tokens (chars / 3.5) per chunk, like the knowledge chunker. */
function evalChunks(): string[] {
  return PASSAGES.map((_, i) => {
    let text = ''
    for (let k = 0; text.length < 2100; k++) text += `${PASSAGES[(i + k) % PASSAGES.length]!.text}\n\n`
    return text.slice(0, 2100)
  })
}

function withDtype(level: LocalEmbeddingLevel, dtype: LocalModelDtype | undefined): LocalEmbeddingLevel {
  if (!dtype || dtype === level.model.dtype) return level
  const external = level.model.files.some((f) => f.endsWith('_data'))
  return { ...level, model: { ...level.model, dtype, files: onnxModelFiles(dtype, external) } }
}

export async function measureModel(
  repo: string,
  options: { cacheDir: string; dtype?: LocalModelDtype; threads?: number; log?: (line: string) => void },
): Promise<ModelMeasurement> {
  const levels = localEmbeddingLevels()
    .filter((l) => l.model.repo === repo)
    .map((l) => withDtype(l, options.dtype))
  if (levels.length === 0) throw new Error(`${repo} is not in the catalog`)
  const native = levels.reduce((a, b) => (b.dimensions > a.dimensions ? b : a))
  const log = options.log ?? (() => {})
  const providerOptions = {
    cacheDir: options.cacheDir,
    ...(options.threads ? { threads: options.threads } : {}),
  }

  let downloadMs: number | null = null
  if (!isLocalModelDownloaded(options.cacheDir, native.model)) {
    let lastLog = 0
    const downloader = new LocalEmbeddingProvider(native, {
      ...providerOptions,
      onProgress: (p) => {
        if (Date.now() - lastLog < 3000 && !p.done) return
        lastLog = Date.now()
        log(`${repo} (${native.model.dtype}): ${(p.progress * 100).toFixed(0)}% of ${mb(p.totalBytes)} MB`)
      },
    })
    const started = Date.now()
    await downloader.prepare()
    downloadMs = Date.now() - started
    await downloader.dispose()
  }

  // Fresh worker: its peak RSS is this model's alone.
  const provider = new LocalEmbeddingProvider(native, providerOptions)
  const loadStarted = Date.now()
  await provider.prepare()
  const loadMs = Date.now() - loadStarted
  const loadedRss = (await provider.host.stats())!.rssBytes

  await provider.embed(['model warmup', 'second short sentence'], 'document')

  const passages = PASSAGES.map((p) => p.text)
  let started = performance.now()
  const docs = await provider.embed(passages, 'document')
  const passagesPerSecond = passages.length / ((performance.now() - started) / 1000)

  const chunks = evalChunks()
  started = performance.now()
  const long = await provider.embed(chunks, 'document')
  const chunksPerSecond = chunks.length / ((performance.now() - started) / 1000)

  started = performance.now()
  for (const q of QUERIES.slice(0, 10)) await provider.embed([q.query], 'query')
  const queryMs = (performance.now() - started) / 10
  const queries = await provider.embed(
    QUERIES.map((q) => q.query),
    'query',
  )
  const stats = (await provider.host.stats())!
  await provider.dispose()

  const bm25 = new Bm25(PASSAGES)
  const lexicalHits = QUERIES.map((q) => bm25.search(q.query, 30))
  const lexical = lexicalHits.map((hits) => hits.map((r) => r.id))
  const results = levels.map((level): LevelResult => {
    const fit = (v: Float32Array) => (level.dimensions < v.length ? truncateMrl(v, level.dimensions) : v)
    const index = new Int8VectorIndex(level.dimensions)
    docs.vectors.forEach((v, i) => index.add(PASSAGES[i]!.id, fit(v)))
    const vectorHits = queries.vectors.map((q) => index.search(fit(q), index.size))
    const vector = vectorHits.map((hits) => hits.slice(0, 30).map((h) => h.id))
    const scoreFusion = vectorHits.map((hits, i) => {
      const lexicalScores = new Map(lexicalHits[i]!.map((h) => [h.id, h.score]))
      const best = Math.max(0, ...lexicalScores.values())
      const candidates = new Set([...vector[i]!, ...lexical[i]!])
      return hits
        .filter((h) => candidates.has(h.id))
        .map((h) => ({
          id: h.id,
          score: 0.8 * h.score + (best > 0 ? (0.2 * (lexicalScores.get(h.id) ?? 0)) / best : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .map((h) => h.id)
    })
    const fuse = (bm25Weight: number) =>
      vector.map((ids, i) =>
        reciprocalRankFusion([{ ids: lexical[i]!, weight: bm25Weight }, { ids }], { k: 60 }).map((r) => r.id),
      )
    return {
      family: level.family,
      level: level.id,
      key: localEmbeddingSpaceKey(level),
      dimensions: level.dimensions,
      vector: evaluate(vector, QUERIES),
      hybrid: evaluate(fuse(1), QUERIES),
      hybridHalfBm25: evaluate(fuse(0.5), QUERIES),
      hybridQuarterBm25: evaluate(fuse(0.25), QUERIES),
      hybridScore: evaluate(scoreFusion, QUERIES),
      hybridAdaptive: evaluate(
        vector.map((ids, i) =>
          reciprocalRankFusion(
            [{ ids: lexical[i]!, weight: lexicalQueryWeight(QUERIES[i]!.query) }, { ids }],
            {
              k: 60,
            },
          ).map((r) => r.id),
        ),
        QUERIES,
      ),
    }
  })

  return {
    repo,
    dtype: native.model.dtype,
    threads: provider.host.threads,
    downloadBytes: localModelDiskBytes(options.cacheDir, native.model),
    downloadMs,
    loadMs,
    loadedRssMb: mb(loadedRss),
    peakRssMb: mb(stats.peakRssBytes),
    passagesPerSecond,
    passageTokens: (docs.usage?.tokens ?? 0) / passages.length,
    chunksPerSecond,
    chunkTokens: (long.usage?.tokens ?? 0) / chunks.length,
    queryMs,
    levels: results,
  }
}

export function bm25Only(): MetricsByKind {
  const bm25 = new Bm25(PASSAGES)
  return evaluate(
    QUERIES.map((q) => bm25.search(q.query, 30).map((r) => r.id)),
    QUERIES,
  )
}
