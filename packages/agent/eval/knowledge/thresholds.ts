/**
 * Relevance thresholds of the knowledge base with real local models: cosine distributions of relevant
 * and irrelevant pairs, and precision/recall sweeps for the per-turn document suggestion (chat message
 * vs summary vector), the automatic excerpts (message vs ~600-token chunks), the text-only rule
 * (`minTerms`) and the neighbor merging ratio of the hybrid search.
 *
 *   EVAL_MODELS_DIR=<model cache dir> pnpm --filter @milibot/agent eval:knowledge-thresholds
 *
 * Options (env): EVAL_MODELS=<repo[:dtype],…> (default: EmbeddingGemma q4, multilingual-e5 small and
 * base), EVAL_OUT=<markdown file>, EVAL_JSON=<json file with the score matrices>, EVAL_FROM_JSON=<that
 * file> (analysis only, no model).
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { foldText } from '@milibot/shared'

import {
  localEmbeddingLevels,
  localEmbeddingSpaceKey,
  type LocalModelDtype,
} from '../../src/embeddings/catalog'
import { LocalEmbeddingProvider } from '../../src/embeddings/local'
import { lexicalQueryWeight, reciprocalRankFusion } from '../../src/embeddings/rrf'
import { truncateMrl } from '../../src/embeddings/vector'
import { Int8VectorIndex } from '../../src/embeddings/vector-index'
import { searchTerms, termPrefix } from '../../src/memory/search'
import { PASSAGES, QUERIES } from './corpus'
import { CHAT, type ChatMessage, checkRelevanceData, DOCS } from './relevance'

interface Chunk {
  doc: string
  passages: string[]
  text: string
}

interface Half {
  doc: string
  passage: string
  seq: number
  text: string
}

/** Score matrices of one catalog level (rows: queries or messages; columns: docs, chunks, halves). */
interface LevelScores {
  key: string
  chatVsDocs: number[][]
  chatVsChunks: number[][]
  queryVsChunks: number[][]
  queryVsHalves: number[][]
}

const CHUNK_CHARS = 2100

/** Passages of each document packed into ~600-token chunks, like the chunker does with real files. */
function buildChunks(): Chunk[] {
  const chunks: Chunk[] = []
  for (const doc of DOCS) {
    let current: Chunk | null = null
    for (const p of PASSAGES.filter((x) => x.doc === doc.title)) {
      if (current && current.text.length + p.text.length + 2 > CHUNK_CHARS) {
        chunks.push(current)
        current = null
      }
      current ??= { doc: doc.title, passages: [], text: '' }
      current.text = current.text ? `${current.text}\n\n${p.text}` : p.text
      current.passages.push(p.id)
    }
    if (current) chunks.push(current)
  }
  return chunks
}

/** Every passage cut in two at the sentence boundary closest to the middle, in document order. */
function buildHalves(): Half[] {
  const halves: Half[] = []
  for (const doc of DOCS) {
    let seq = 0
    for (const p of PASSAGES.filter((x) => x.doc === doc.title)) {
      const middle = p.text.length / 2
      let cut = -1
      for (let i = p.text.indexOf('. '); i >= 0; i = p.text.indexOf('. ', i + 1))
        if (cut < 0 || Math.abs(i - middle) < Math.abs(cut - middle)) cut = i
      const parts = cut > 0 ? [p.text.slice(0, cut + 1), p.text.slice(cut + 2)] : [p.text]
      for (const text of parts) halves.push({ doc: doc.title, passage: p.id, seq: seq++, text })
    }
  }
  return halves
}

const CHUNKS = buildChunks()
const HALVES = buildHalves()
const summaryText = (d: { title: string; summary: string }) => `${d.title}\n${d.summary}`

function scoreMatrix(queries: Float32Array[], docs: Float32Array[], dims: number): number[][] {
  const index = new Int8VectorIndex<number>(dims)
  docs.forEach((v, i) => index.add(i, v))
  return queries.map((q) => {
    const row = new Array<number>(docs.length).fill(0)
    for (const hit of index.search(q, docs.length)) row[hit.id] = hit.score
    return row
  })
}

async function measure(repo: string, dtype: LocalModelDtype | undefined, cacheDir: string) {
  const levels = localEmbeddingLevels().filter((l) => l.model.repo === repo)
  if (!levels.length) throw new Error(`${repo} is not in the catalog`)
  const native = levels.reduce((a, b) => (b.dimensions > a.dimensions ? b : a))
  const model = dtype ? { ...native, model: { ...native.model, dtype } } : native
  const provider = new LocalEmbeddingProvider(model, { cacheDir })
  await provider.prepare()
  const embed = async (texts: string[], kind: 'query' | 'document') =>
    (await provider.embed(texts, kind)).vectors
  const docs = await embed(DOCS.map(summaryText), 'document')
  const chunks = await embed(
    CHUNKS.map((c) => c.text),
    'document',
  )
  const halves = await embed(
    HALVES.map((h) => h.text),
    'document',
  )
  const chat = await embed(
    CHAT.map((m) => m.text),
    'query',
  )
  const queries = await embed(
    QUERIES.map((q) => q.query),
    'query',
  )
  await provider.dispose()
  return levels.map((level): LevelScores => {
    const fit = (vs: Float32Array[]) =>
      vs.map((v) => (level.dimensions < v.length ? truncateMrl(v, level.dimensions) : v))
    const [d, c, h, m, q] = [docs, chunks, halves, chat, queries].map(fit) as Float32Array[][]
    return {
      key: localEmbeddingSpaceKey({ ...level, model: model.model }),
      chatVsDocs: scoreMatrix(m!, d!, level.dimensions),
      chatVsChunks: scoreMatrix(m!, c!, level.dimensions),
      queryVsChunks: scoreMatrix(q!, c!, level.dimensions),
      queryVsHalves: scoreMatrix(q!, h!, level.dimensions),
    }
  })
}

const f2 = (v: number) => v.toFixed(2)
const f3 = (v: number) => v.toFixed(3)
const pct = (v: number) => `${(v * 100).toFixed(0)}%`

function quantiles(values: number[]): string {
  if (!values.length) return '—'
  const s = [...values].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]!
  return `${f3(s[0]!)} / ${f3(q(0.1))} / ${f3(q(0.5))} / ${f3(q(0.9))} / ${f3(s.at(-1)!)}`
}

/** Distinct query terms in `text` (the daemon's `matchedTerms`), plus whether FTS5 would match at all. */
function textMatch(text: string, terms: string[]): { count: number; fts: boolean } {
  const lower = foldText(text)
  const words = lower.split(/[^\p{L}\p{N}]+/u)
  const count = terms.filter((t) => lower.includes(termPrefix(t) ?? t)).length
  const fts = terms.some((t) => {
    const prefix = termPrefix(t)
    return words.some((w) => (prefix ? w.startsWith(prefix) : w === t))
  })
  return { count, fts }
}

const docText = (d: (typeof DOCS)[number]) => `${d.title} ${d.title} ${d.summary}`
const chunkText = (c: Chunk) => c.text

/** Text-only candidates as the daemon filters them: FTS match and at least `minTerms` shared terms. */
function textCandidates(query: string, texts: string[], minTerms: number): number[] {
  const terms = searchTerms(query)
  return texts
    .map((t, i) => ({ i, ...textMatch(t, terms) }))
    .filter((m) => m.fts && m.count >= minTerms)
    .sort((a, b) => b.count - a.count)
    .map((m) => m.i)
}

interface SuggestionStats {
  correct: number
  wrong: number
  found: number
  expected: number
  silentNone: number
  none: number
  /** Messages about a document with at least one false alarm. */
  noisyDocMsgs: number
}

const isNone = (m: ChatMessage) => m.kind === 'none'
const isDocMsg = (m: ChatMessage) => m.expected.length > 0

/**
 * How text-only candidates join a thresholded list: `always` = appended even at weight 0 (prose);
 * `identifiers` = only when the query has identifiers (weight > 0); `strictProse` = always, but prose
 * queries need one more shared term.
 */
type TextMode = 'always' | 'identifiers' | 'strictProse'

const useText = (query: string, mode: TextMode) => mode !== 'identifiers' || lexicalQueryWeight(query) > 0
const termsFor = (query: string, minTerms: number, mode: TextMode) =>
  mode === 'strictProse' && lexicalQueryWeight(query) === 0 ? minTerms + 1 : minTerms

/** `suggestDocs`: summary vectors ≥ t fused with text-only candidates (weight from the query), top 4. */
function suggestions(scores: number[][], t: number, minTerms: number, mode: TextMode): number[][] {
  const texts = DOCS.map(docText)
  return CHAT.map((m, i) => {
    const vector = scores[i]!.map((s, d) => ({ s, d }))
      .filter((x) => x.s >= t)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.d)
    const text = useText(m.text, mode)
      ? textCandidates(m.text, texts, termsFor(m.text, minTerms, mode)).slice(0, 10)
      : []
    return reciprocalRankFusion<number>(
      [
        { ids: vector, weight: 1 },
        { ids: text, weight: lexicalQueryWeight(m.text) },
      ],
      { k: 60, limit: 4 },
    ).map((f) => f.id)
  })
}

function suggestionStats(picked: number[][]): SuggestionStats {
  const stats: SuggestionStats = {
    correct: 0,
    wrong: 0,
    found: 0,
    expected: 0,
    silentNone: 0,
    none: 0,
    noisyDocMsgs: 0,
  }
  CHAT.forEach((m, i) => {
    const titles = picked[i]!.map((d) => DOCS[d]!.title)
    const ok = new Set([...m.expected, ...(m.acceptable ?? [])])
    const wrong = titles.filter((t) => !ok.has(t)).length
    stats.correct += titles.length - wrong
    stats.wrong += wrong
    stats.expected += m.expected.length
    stats.found += m.expected.filter((t) => titles.includes(t)).length
    if (isNone(m)) {
      stats.none++
      if (!titles.length) stats.silentNone++
    }
    if (isDocMsg(m) && wrong) stats.noisyDocMsgs++
  })
  return stats
}

const precision = (s: SuggestionStats) => (s.correct + s.wrong ? s.correct / (s.correct + s.wrong) : 1)
const recall = (s: SuggestionStats) => s.found / Math.max(1, s.expected)
const fBeta = (p: number, r: number, beta: number) =>
  p + r ? ((1 + beta * beta) * p * r) / (beta * beta * p + r) : 0

const GRID = Array.from({ length: 91 }, (_, i) => Math.round((0.05 + i * 0.01) * 100) / 100)

interface ChunkStats {
  /** QUERIES with an expected passage in a kept chunk. */
  queryRecall: number
  /** Kept chunks (QUERIES) from the document of an expected passage. */
  queryOnTopic: number
  /** Chat messages about no document with no excerpt. */
  silentNone: number
  /** Chat messages about a document: kept excerpts from an expected/acceptable document. */
  chatOnTopic: number
  chatRecall: number
}

const docOfPassage = new Map(PASSAGES.map((p) => [p.id, p.doc]))

function chunkStats(level: LevelScores, t: number, minTerms: number, mode: TextMode): ChunkStats {
  const texts = CHUNKS.map(chunkText)
  const kept = (query: string, row: number[]) => {
    const vector = row
      .map((s, c) => ({ s, c }))
      .filter((x) => x.s >= t)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
    const text = useText(query, mode) ? textCandidates(query, texts, termsFor(query, minTerms, mode)) : []
    return reciprocalRankFusion<number>(
      [
        { ids: text, weight: lexicalQueryWeight(query) },
        { ids: vector, weight: 1 },
      ],
      { k: 60, limit: 3 },
    ).map((f) => f.id)
  }
  let recallHits = 0
  let onTopic = 0
  let keptTotal = 0
  QUERIES.forEach((q, i) => {
    const ids = kept(q.query, level.queryVsChunks[i]!)
    const docs = new Set(q.expected.map((p) => docOfPassage.get(p)))
    if (ids.some((c) => CHUNKS[c]!.passages.some((p) => q.expected.includes(p)))) recallHits++
    keptTotal += ids.length
    onTopic += ids.filter((c) => docs.has(CHUNKS[c]!.doc)).length
  })
  let silent = 0
  let none = 0
  let chatKept = 0
  let chatOk = 0
  let chatFound = 0
  let chatDoc = 0
  CHAT.forEach((m, i) => {
    const ids = kept(m.text, level.chatVsChunks[i]!)
    if (isNone(m)) {
      none++
      if (!ids.length) silent++
    }
    if (isDocMsg(m)) {
      chatDoc++
      const ok = new Set([...m.expected, ...(m.acceptable ?? [])])
      chatKept += ids.length
      chatOk += ids.filter((c) => ok.has(CHUNKS[c]!.doc)).length
      if (ids.some((c) => m.expected.includes(CHUNKS[c]!.doc))) chatFound++
    }
  })
  return {
    queryRecall: recallHits / QUERIES.length,
    queryOnTopic: keptTotal ? onTopic / keptTotal : 1,
    silentNone: silent / none,
    chatOnTopic: chatKept ? chatOk / chatKept : 1,
    chatRecall: chatFound / chatDoc,
  }
}

interface MergeSample {
  ratio: number
  diff: number
  same: boolean
}

/** Seed = best half for each question; its neighbors in the same document, continuation or not. */
function mergeSamples(level: LevelScores): MergeSample[] {
  const samples: MergeSample[] = []
  QUERIES.forEach((q, i) => {
    const row = level.queryVsHalves[i]!
    const seed = row.indexOf(Math.max(...row))
    const s = HALVES[seed]!
    if (!q.expected.includes(s.passage)) return
    for (const step of [-1, 1]) {
      const n = HALVES.findIndex((h) => h.doc === s.doc && h.seq === s.seq + step)
      if (n < 0) continue
      const neighbor = HALVES[n]!
      const same = neighbor.passage === s.passage || q.expected.includes(neighbor.passage)
      samples.push({ ratio: row[n]! / row[seed]!, diff: row[seed]! - row[n]!, same })
    }
  })
  return samples
}

function report(levels: LevelScores[]): string {
  const out: string[] = []
  const none = CHAT.filter(isNone).length
  const docMsgs = CHAT.filter(isDocMsg).length
  out.push(
    `Chat messages: ${CHAT.length} (${none} about no document, ${CHAT.filter((m) => m.kind === 'near').length} near a topic, ${docMsgs} about documents: ` +
      `${CHAT.filter((m) => m.kind === 'direct').length} direct, ${CHAT.filter((m) => m.kind === 'indirect').length} indirect, ${CHAT.filter((m) => m.kind === 'english').length} in English). ` +
      `${DOCS.length} documents with a summary; ${CHUNKS.length} excerpts of ~600 tokens; ${QUERIES.length} questions from the search eval. Cosine via \`Int8VectorIndex\`.`,
    '',
    '## Distributions (min / p10 / median / p90 / max)',
    '',
    '| Space | expected summary | best wrong summary (msg about a doc) | best summary (msg about no doc) | expected excerpt (questions) | best excerpt (msg about no doc) |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  for (const level of levels) {
    const relevant: number[] = []
    const wrongBest: number[] = []
    const noneBest: number[] = []
    CHAT.forEach((m, i) => {
      const row = level.chatVsDocs[i]!
      const ok = new Set([...m.expected, ...(m.acceptable ?? [])])
      if (isNone(m)) noneBest.push(Math.max(...row))
      if (isDocMsg(m)) {
        m.expected.forEach((t) => relevant.push(row[DOCS.findIndex((d) => d.title === t)]!))
        wrongBest.push(Math.max(...row.filter((_, d) => !ok.has(DOCS[d]!.title))))
      }
    })
    const chunkRelevant = QUERIES.map((q, i) =>
      Math.max(
        ...CHUNKS.map((c, ci) =>
          c.passages.some((p) => q.expected.includes(p)) ? level.queryVsChunks[i]![ci]! : -1,
        ),
      ),
    )
    const chunkNone = CHAT.flatMap((m, i) => (isNone(m) ? [Math.max(...level.chatVsChunks[i]!)] : []))
    out.push(
      `| ${level.key} | ${quantiles(relevant)} | ${quantiles(wrongBest)} | ${quantiles(noneBest)} | ${quantiles(chunkRelevant)} | ${quantiles(chunkNone)} |`,
    )
  }

  out.push(
    '',
    '## Document suggestions (summary vector ≥ t + text branch with minTerms 2, top 4; max F1/F0.5 measured with "prose w/ minTerms 3")',
    '',
    'Precision = right suggestions (expected or acceptable) / all; recall = expected documents suggested; silence = messages about no document with no suggestion; noisy msgs = messages about a document with some wrong suggestion. ' +
      '"text always" = text-only candidates join even at weight 0 (prose), as the product used to; "text only w/ identifiers" = only when `lexicalQueryWeight` > 0.',
    '',
  )
  const suggestionRows = (level: LevelScores, mode: TextMode) =>
    GRID.map((t) => ({ t, s: suggestionStats(suggestions(level.chatVsDocs, t, 2, mode)) }))
  const bestBy = (rows: Array<{ t: number; s: SuggestionStats }>, beta: number) =>
    rows.reduce((a, b) =>
      fBeta(precision(b.s), recall(b.s), beta) > fBeta(precision(a.s), recall(a.s), beta) ? b : a,
    )
  for (const level of levels) {
    const always = suggestionRows(level, 'always')
    const strict = suggestionRows(level, 'strictProse')
    const ids = suggestionRows(level, 'identifiers')
    const best = bestBy(strict, 1)
    const best05 = bestBy(strict, 0.5)
    out.push(
      `### ${level.key}`,
      '',
      '| t | text always: precision | recall | silence | prose w/ minTerms 3: precision | recall | F1 | silence | text only w/ identifiers: precision | recall | F1 | F0.5 | silence | wrong suggestions | noisy msgs |',
      '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    )
    ids.forEach(({ t, s }, i) => {
      const gap = Math.abs(t - best.t)
      const near = gap <= 0.04 || (gap <= 0.1 && Math.round(t * 100) % 2 === 0)
      if (!near && t !== best.t && t !== best05.t) return
      const a = always[i]!.s
      const st = strict[i]!.s
      const p = precision(s)
      const r = recall(s)
      const mark = [t === best.t ? 'max F1' : '', t === best05.t ? 'max F0.5' : ''].filter(Boolean).join(', ')
      out.push(
        `| ${f2(t)}${mark ? ` (${mark})` : ''} | ${pct(precision(a))} | ${pct(recall(a))} | ${a.silentNone}/${a.none} | ` +
          `${pct(precision(st))} | ${pct(recall(st))} | ${f2(fBeta(precision(st), recall(st), 1))} | ${st.silentNone}/${st.none} | ` +
          `${pct(p)} | ${pct(r)} | ${f2(fBeta(p, r, 1))} | ${f2(fBeta(p, r, 0.5))} | ${s.silentNone}/${s.none} | ${s.wrong} | ${s.noisyDocMsgs}/${docMsgs} |`,
      )
    })
    out.push('')
  }

  out.push(
    '## Text only (minTerms): messages about no document with a text-only candidate, and expected documents found by text alone',
    '',
    '| minTerms | no-doc msgs with a suggestion | wrong suggestions | expected docs found | no-doc msgs with an excerpt |',
    '| ---: | ---: | ---: | ---: | ---: |',
  )
  for (const minTerms of [1, 2, 3]) {
    const s = suggestionStats(
      suggestions(
        CHAT.map(() => DOCS.map(() => 0)),
        2,
        minTerms,
        'always',
      ),
    )
    const textOnly = CHAT.map((m) =>
      textCandidates(m.text, DOCS.map(docText), minTerms).map((d) => DOCS[d]!.title),
    )
    const found = CHAT.reduce((n, m, i) => n + m.expected.filter((t) => textOnly[i]!.includes(t)).length, 0)
    const chunkNoise = CHAT.filter(
      (m) => isNone(m) && textCandidates(m.text, CHUNKS.map(chunkText), minTerms).length,
    ).length
    const noisy = CHAT.filter((m, i) => isNone(m) && textOnly[i]!.length).length
    out.push(
      `| ${minTerms} | ${noisy}/${none} | ${s.wrong} | ${found}/${CHAT.reduce((n, m) => n + m.expected.length, 0)} | ${chunkNoise}/${none} |`,
    )
  }

  out.push(
    '',
    '## Automatic excerpts (top 3, cosine ≥ t + text branch: minTerms 2, 3 in prose)',
    '',
    'Recall = eval questions with the expected excerpt among the kept ones; on topic = kept excerpts from the right document; silence = messages about no document with no excerpt.',
    '',
  )
  for (const level of levels) {
    out.push(
      `### ${level.key}`,
      '',
      '| t | recall (questions) | on topic (questions) | recall (chat) | on topic (chat) | silence | text always: recall (questions) / silence | text only w/ identifiers: recall (questions) / silence |',
      '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    )
    for (const t of GRID) {
      const s = chunkStats(level, t, 2, 'strictProse')
      if (s.silentNone === 0 || s.queryRecall < 0.6) continue
      const a = chunkStats(level, t, 2, 'always')
      const ids = chunkStats(level, t, 2, 'identifiers')
      out.push(
        `| ${f2(t)} | ${pct(s.queryRecall)} | ${pct(s.queryOnTopic)} | ${pct(s.chatRecall)} | ${pct(s.chatOnTopic)} | ${pct(s.silentNone)} | ${pct(a.queryRecall)} / ${pct(a.silentNone)} | ${pct(ids.queryRecall)} / ${pct(ids.silentNone)} |`,
      )
    }
    out.push('')
  }

  const ratios = [0.75, 0.8, 0.85, 0.9, 0.95, 0.97]
  out.push(
    '## Neighbor merging (seed = best half; neighbor = continuation of the same excerpt or expected excerpt, or another subject)',
    '',
    `Ratio = neighbor cosine / seed cosine. Columns: merges continuation / other subject at the given minimum ratio.`,
    '',
    `| Space | continuation ratio | other-subject ratio | ${ratios.map((r) => f2(r)).join(' | ')} |`,
    `| --- | --- | --- | ${ratios.map(() => '---').join(' | ')} |`,
  )
  for (const level of levels) {
    const samples = mergeSamples(level)
    const same = samples.filter((s) => s.same)
    const other = samples.filter((s) => !s.same)
    const rate = (xs: MergeSample[], r: number) =>
      pct(xs.filter((x) => x.ratio >= r).length / Math.max(1, xs.length))
    out.push(
      `| ${level.key} | ${quantiles(same.map((s) => s.ratio))} | ${quantiles(other.map((s) => s.ratio))} | ` +
        `${ratios.map((r) => `${rate(same, r)} / ${rate(other, r)}`).join(' | ')} |`,
    )
  }
  return out.join('\n')
}

async function main(): Promise<void> {
  checkRelevanceData()
  let levels: LevelScores[]
  if (process.env.EVAL_FROM_JSON) {
    levels = JSON.parse(readFileSync(process.env.EVAL_FROM_JSON, 'utf8')) as LevelScores[]
  } else {
    const cacheDir = process.env.EVAL_MODELS_DIR
    if (!cacheDir) {
      console.error('Set EVAL_MODELS_DIR (a directory for the model cache).')
      process.exit(2)
    }
    const targets = (
      process.env.EVAL_MODELS?.split(',') ?? [
        'onnx-community/embeddinggemma-300m-ONNX',
        'Xenova/multilingual-e5-small',
        'Xenova/multilingual-e5-base',
      ]
    ).map((entry) => {
      const [repo, dtype] = entry.split(':')
      return { repo: repo!, dtype: dtype as LocalModelDtype | undefined }
    })
    levels = []
    for (const target of targets) {
      console.error(`measuring ${target.repo}${target.dtype ? ` (${target.dtype})` : ''}…`)
      levels.push(...(await measure(target.repo, target.dtype, cacheDir)))
    }
    if (process.env.EVAL_JSON) writeFileSync(process.env.EVAL_JSON, JSON.stringify(levels))
  }
  const text = report(levels)
  console.log(text)
  if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, `${text}\n`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
