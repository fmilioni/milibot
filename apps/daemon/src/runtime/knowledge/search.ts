import { ftsMatchExpression, searchTerms, termPrefix } from '@milibot/agent'
import { lexicalQueryWeight, reciprocalRankFusion } from '@milibot/agent/embeddings'
import type { KnowledgeKind, KnowledgeSearchHit, ProjectView } from '@milibot/shared'
import { estimateTokens, foldText } from '@milibot/shared'

import {
  type EmbeddingService,
  type KnowledgeThresholds,
  textMinTerms,
  thresholdsForSpace,
} from '../embeddings'
import { stripPageMarkers } from './chunker'
import { SUMMARY_CORPUS } from './corpus'
import type { ChunkRow, DocRow, KnowledgeStore } from './store'

/** Candidates taken from each list before fusion. */
const CANDIDATES = 30
const RRF_K = 60
const MERGE_MAX_CHUNKS = 3

export interface SearchDeps {
  store: KnowledgeStore
  embeddings: EmbeddingService
  /** `content.md` of a document (null when missing). */
  readContent: (docId: string) => string | null
}

export interface HybridSearchOptions {
  query: string
  topK: number
  /** Only documents this bot can see (null: every document, the settings screen). */
  botId: string | null
  /** Restrict to these documents. */
  docIds?: string[] | null
  /** Projects whose documents count (default: every project). */
  project?: ProjectView
  /** How long the query embedding may take, and whether it may load the model. */
  vector: { timeoutMs: number; loadModel: boolean }
  /** Hits must reach this cosine similarity (hybrid) or match enough query terms (text only). */
  threshold?: { minVectorScore: number } & Pick<KnowledgeThresholds, 'minTerms' | 'proseMinTerms'>
}

export interface SearchHit extends KnowledgeSearchHit {
  vectorScore: number | null
}

export interface SearchOutcome {
  hits: SearchHit[]
  mode: 'hybrid' | 'text'
  space: string | null
}

/** Distinct query terms found in `text` (inflections by prefix, accents and case ignored). */
function matchedTerms(text: string, terms: string[]): number {
  const lower = foldText(text)
  return terms.filter((t) => lower.includes(termPrefix(t) ?? t)).length
}

/** Documents a search may look at: visible to the bot, not failed, optionally restricted. */
function allowedDocs(
  store: KnowledgeStore,
  botId: string | null,
  docIds?: string[] | null,
  project?: ProjectView,
): string[] | null {
  if (!botId && !docIds && (!project || project.mode === 'any')) return null
  return store
    .ids({ ...(botId ? { botId } : {}), ...(docIds ? { ids: docIds } : {}), ...(project ? { project } : {}) })
    .filter((id) => store.find(id)?.status !== 'failed')
}

function pageLabel(from: number | null, to: number | null): string {
  if (from === null) return ''
  return to !== null && to !== from ? `pp. ${from}–${to}` : `p. ${from}`
}

/** "Contract.pdf · p. 12 · Payment" */
function hitSource(hit: Pick<SearchHit, 'title' | 'pageFrom' | 'pageTo' | 'heading'>): string {
  return [hit.title, pageLabel(hit.pageFrom, hit.pageTo), hit.heading].filter(Boolean).join(' · ')
}

/** The text of consecutive chunks without repeating their overlap. */
function mergedText(deps: SearchDeps, doc: DocRow, group: ChunkRow[]): string {
  if (group.length === 1) return (group[0] as ChunkRow).text
  const content = deps.readContent(doc.id)
  const first = group[0] as ChunkRow
  const last = group.at(-1) as ChunkRow
  if (content !== null && last.char_end <= content.length) {
    const body = stripPageMarkers(content.slice(first.char_start, last.char_end))
    if (doc.kind !== 'csv') return body
    const header = first.text.split('\n')[0] ?? ''
    return body.startsWith(header) ? body : `${header}\n${body}`
  }
  return group.map((c) => c.text).join('\n…\n')
}

/**
 * Hybrid search: FTS5 BM25 and vector similarity (top 30 each) fused with reciprocal rank fusion
 * (k = 60); neighbouring chunks of the same document are merged into one hit. Without vectors (no model
 * yet, model unavailable) it is a text search.
 */
export async function hybridSearch(deps: SearchDeps, options: HybridSearchOptions): Promise<SearchOutcome> {
  const { store, embeddings } = deps
  const allowed = allowedDocs(store, options.botId, options.docIds, options.project)
  if (allowed && !allowed.length) return { hits: [], mode: 'text', space: null }
  const terms = searchTerms(options.query)
  const match = ftsMatchExpression(terms)
  const textHits = match ? store.searchChunks(match, allowed, CANDIDATES) : []
  const query = await embeddings.queryVector(options.query, options.vector)
  const vectorHits = query
    ? embeddings.searchChunks(query, CANDIDATES, allowed ? new Set(allowed) : null)
    : []
  const vectorScore = new Map(vectorHits.map((h) => [h.id, h.score]))
  const threshold = options.threshold
  const keptVector = threshold ? vectorHits.filter((h) => h.score >= threshold.minVectorScore) : vectorHits
  // Full text counts in the ranking only for identifier-like queries (codes, paths, quoted words); for
  // prose it only fills in after the vector hits. Without vectors it is the whole ranking.
  const fused = reciprocalRankFusion<number>(
    [
      { ids: textHits.map((h) => h.id), weight: query ? lexicalQueryWeight(options.query) : 1 },
      { ids: keptVector.map((h) => h.id), weight: 1 },
    ],
    { k: RRF_K, limit: options.topK * 3 },
  )
  const chunks = new Map(store.chunksByIds(fused.map((f) => f.id)).map((c) => [c.id, c]))
  const scored = fused.flatMap((f) => {
    const chunk = chunks.get(f.id)
    return chunk
      ? [{ chunk, score: f.score, textRank: f.ranks[0] ?? null, vectorRank: f.ranks[1] ?? null }]
      : []
  })
  // Text-only matches must share enough of the query (a single common word is not a hit).
  const minTerms = threshold ? textMinTerms(threshold, options.query, query !== null) : 0
  const filtered = threshold
    ? scored.filter(
        (s) => s.vectorRank !== null || matchedTerms(`${s.chunk.heading} ${s.chunk.text}`, terms) >= minTerms,
      )
    : scored

  // Best chunks seed the hits; an adjacent chunk joins only when it matches about as well (similarity
  // close to the seed's, or a full-text match when the seed has no vector), so a weak neighbor never
  // stretches a hit over the whole document. Fused scores are too close to each other to compare.
  const mergeMinRatio = thresholdsForSpace(query?.space ?? null).mergeMinRatio
  const bySeq = new Map(filtered.map((item) => [`${item.chunk.doc_id}:${item.chunk.seq}`, item]))
  const used = new Set<(typeof filtered)[number]>()
  const ranked: Array<{ docId: string; items: typeof filtered; score: number }> = []
  for (const seed of [...filtered].sort((a, b) => b.score - a.score)) {
    if (ranked.length >= options.topK) break
    if (used.has(seed)) continue
    used.add(seed)
    const items = [seed]
    const seedSimilarity = vectorScore.get(seed.chunk.id)
    const neighbor = (seq: number) => {
      const item = bySeq.get(`${seed.chunk.doc_id}:${seq}`)
      if (!item || used.has(item)) return null
      const similarity = vectorScore.get(item.chunk.id)
      const close =
        seedSimilarity === undefined
          ? item.textRank !== null
          : similarity !== undefined && similarity >= seedSimilarity * mergeMinRatio
      return close ? item : null
    }
    const grow = (step: -1 | 1) => {
      for (let seq = seed.chunk.seq + step; items.length < MERGE_MAX_CHUNKS; seq += step) {
        const item = neighbor(seq)
        if (!item) return
        used.add(item)
        if (step < 0) items.unshift(item)
        else items.push(item)
      }
    }
    grow(-1)
    grow(1)
    ranked.push({ docId: seed.chunk.doc_id, items, score: seed.score })
  }

  const hits: SearchHit[] = []
  for (const group of ranked) {
    const doc = store.find(group.docId)
    if (!doc) continue
    const rows = group.items.map((i) => i.chunk)
    const first = rows[0] as ChunkRow
    const last = rows.at(-1) as ChunkRow
    const minRank = (values: Array<number | null>) => {
      const present = values.filter((v): v is number => v !== null)
      return present.length ? Math.min(...present) : null
    }
    const scores = rows.map((r) => vectorScore.get(r.id)).filter((v): v is number => v !== undefined)
    hits.push({
      docId: doc.id,
      title: doc.title,
      kind: doc.kind as KnowledgeKind,
      pageFrom: first.page_from,
      pageTo: last.page_to,
      heading: first.heading,
      text: mergedText(deps, doc, rows),
      score: group.score,
      textRank: minRank(group.items.map((i) => i.textRank)),
      vectorRank: minRank(group.items.map((i) => i.vectorRank)),
      vectorScore: scores.length ? Math.max(...scores) : null,
      fromChunk: first.seq,
      toChunk: last.seq,
    })
  }
  return { hits, mode: query ? 'hybrid' : 'text', space: query?.space ?? null }
}

/** Search results as the bots read them. */
export function formatHits(hits: SearchHit[], options: { maxTokens?: number } = {}): string {
  const budget = options.maxTokens ?? Number.POSITIVE_INFINITY
  let used = 0
  const parts: string[] = []
  hits.forEach((hit, i) => {
    const chunks =
      hit.fromChunk === hit.toChunk ? `chunk ${hit.fromChunk}` : `chunks ${hit.fromChunk}–${hit.toChunk}`
    const head = `[${i + 1}] ${hitSource(hit)} (${hit.docId}, ${chunks})`
    const room = Math.max(0, budget - used - estimateTokens(head))
    if (room < 40 && parts.length) return
    const maxChars = Number.isFinite(room) ? Math.floor(room * 3.5) : hit.text.length
    const text = hit.text.length > maxChars ? `${hit.text.slice(0, maxChars).trimEnd()}…` : hit.text
    const part = `${head}\n${text}`
    used += estimateTokens(part)
    parts.push(part)
  })
  return parts.join('\n\n')
}

export interface DocSuggestionOptions {
  query: string
  botId: string
  project?: ProjectView
  limit: number
  exclude: Set<string>
  minVectorScore: number
  minTerms: number
  proseMinTerms: number
  timeoutMs: number
}

/**
 * Documents whose summary is close to the query (summary vectors; without them, full text over title and
 * summary with at least `minTerms` shared terms).
 */
export async function suggestDocs(deps: SearchDeps, options: DocSuggestionOptions): Promise<DocRow[]> {
  const { store, embeddings } = deps
  const allowed = new Set(
    store
      .ids({ botId: options.botId, ...(options.project ? { project: options.project } : {}) })
      .filter((id) => !options.exclude.has(id) && store.find(id)?.status !== 'failed'),
  )
  if (!allowed.size) return []
  const query = await embeddings.queryVector(options.query, {
    timeoutMs: options.timeoutMs,
    loadModel: false,
  })
  const terms = searchTerms(options.query)
  const match = ftsMatchExpression(terms)
  const minTerms = textMinTerms(options, options.query, query !== null)
  const textIds = match
    ? store
        .searchDocs(
          match,
          { botId: options.botId, ...(options.project ? { project: options.project } : {}) },
          10,
        )
        .filter((id) => allowed.has(id))
        .filter((id) => {
          const doc = store.find(id)
          return doc
            ? matchedTerms(`${doc.title} ${doc.file_name} ${doc.summary ?? ''}`, terms) >= minTerms
            : false
        })
    : []
  const vectorIds = query
    ? embeddings
        .searchCorpus(SUMMARY_CORPUS, query, 10, allowed)
        .filter((h) => h.score >= options.minVectorScore)
        .map((h) => h.id)
    : []
  return reciprocalRankFusion<string>(
    [
      { ids: vectorIds, weight: 1 },
      { ids: textIds, weight: query ? lexicalQueryWeight(options.query) : 1 },
    ],
    { k: RRF_K, limit: options.limit },
  ).flatMap((f) => store.find(f.id) ?? [])
}
