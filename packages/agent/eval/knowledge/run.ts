/**
 * Knowledge embedding eval: every local catalog level on a pt-BR corpus (passages with distractors;
 * questions: paraphrases, exact terms, answers spread over passages, English questions). Measures R@1,
 * R@5, MRR, throughput, query latency and the worker's memory, plus BM25 alone and the hybrid RRF.
 *
 *   EVAL_MODELS_DIR=<model cache dir> pnpm --filter @milibot/agent eval:knowledge
 *
 * Options (env): EVAL_MODELS=<repo[:dtype],…> (default: all local models, plus EmbeddingGemma in q8),
 * EVAL_THREADS=<n>, EVAL_OUT=<markdown file>, EVAL_JSON=<json file>. Downloads ~1.5 GB into
 * EVAL_MODELS_DIR.
 */
import { writeFileSync } from 'node:fs'

import { localEmbeddingLevels, type LocalModelDtype } from '../../src/embeddings/catalog'
import { PASSAGES, QUERIES } from './corpus'
import { bm25Only, measureModel, type ModelMeasurement } from './measure'
import type { MetricsByKind, RetrievalMetrics } from './metrics'

const cacheDir = process.env.EVAL_MODELS_DIR
if (!cacheDir) {
  console.error('Set EVAL_MODELS_DIR (a directory for the model cache).')
  process.exit(2)
}

const defaults = [
  ...new Set(localEmbeddingLevels().map((l) => l.model.repo)),
  'onnx-community/embeddinggemma-300m-ONNX:q8',
]
const targets = (process.env.EVAL_MODELS?.split(',') ?? defaults).map((entry) => {
  const [repo, dtype] = entry.split(':')
  return { repo: repo!, dtype: dtype as LocalModelDtype | undefined }
})

const pct = (v: number) => (v * 100).toFixed(1)
const f3 = (v: number) => v.toFixed(3)
const cells = (m: RetrievalMetrics) => `${pct(m.hit1)} | ${pct(m.recall5)} | ${f3(m.mrr)}`

function markdown(results: ModelMeasurement[], bm25: MetricsByKind): string {
  const lines: string[] = []
  lines.push(
    `Corpus: ${PASSAGES.length} pt-BR passages, ${QUERIES.length} questions ` +
      `(${QUERIES.filter((q) => q.kind === 'paraphrase').length} paraphrases, ` +
      `${QUERIES.filter((q) => q.kind === 'exact').length} exact terms, ` +
      `${QUERIES.filter((q) => q.kind === 'spread').length} with a spread answer, ` +
      `${QUERIES.filter((q) => q.kind === 'crosslingual').length} in English). ` +
      'Vectors in int8 in `Int8VectorIndex`; hybrid RRF = RRF (k = 60) of BM25 top 30 + vector top 30 with equal weights; ' +
      'adaptive hybrid = the same with the BM25 weight from `lexicalQueryWeight` (1 for identifiers, 0 for prose). ' +
      'R@1 = the first result answers; R@5 = share of the expected passages in the top 5; MRR = 1/rank of the first expected one.',
    '',
    '| Model | Level | dims | dtype | Download | RAM loaded | RAM peak | passages/s | chunks ~600 tok/s | ms/query | R@1 | R@5 | MRR | Hybrid RRF R@1 | R@5 | MRR | Adaptive hybrid R@1 | R@5 | MRR |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const r of results) {
    for (const level of r.levels) {
      lines.push(
        `| ${r.repo.split('/')[1]} | ${level.level} | ${level.dimensions} | ${r.dtype} | ` +
          `${Math.round(r.downloadBytes / 1e6)} MB | ${r.loadedRssMb} MB | ${r.peakRssMb} MB | ` +
          `${r.passagesPerSecond.toFixed(1)} | ${r.chunksPerSecond.toFixed(1)} | ${r.queryMs.toFixed(0)} | ` +
          `${cells(level.vector.all)} | ${cells(level.hybrid.all)} | ${cells(level.hybridAdaptive.all)} |`,
      )
    }
  }
  lines.push(`| BM25 (FTS5-like) | — | — | — | — | — | — | — | — | — | ${cells(bm25.all)} | | | | | | |`)
  lines.push(
    '',
    'By question kind (R@1 / R@5 / MRR):',
    '',
    '| Model | Level | dtype | search | paraphrase | exact term | spread | English |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  const kinds = (m: MetricsByKind) =>
    `${pct(m.paraphrase.hit1)} / ${pct(m.paraphrase.recall5)} / ${f3(m.paraphrase.mrr)} | ` +
    `${pct(m.exact.hit1)} / ${pct(m.exact.recall5)} / ${f3(m.exact.mrr)} | ` +
    `${pct(m.spread.hit1)} / ${pct(m.spread.recall5)} / ${f3(m.spread.mrr)} | ` +
    `${pct(m.crosslingual.hit1)} / ${pct(m.crosslingual.recall5)} / ${f3(m.crosslingual.mrr)}`
  for (const r of results) {
    for (const level of r.levels) {
      const name = `${r.repo.split('/')[1]} | ${level.level} | ${r.dtype}`
      lines.push(`| ${name} | vector | ${kinds(level.vector)} |`)
      lines.push(`| ${name} | hybrid | ${kinds(level.hybrid)} |`)
      lines.push(`| ${name} | hybrid (BM25 ×0.5) | ${kinds(level.hybridHalfBm25)} |`)
      lines.push(`| ${name} | hybrid (BM25 ×0.25) | ${kinds(level.hybridQuarterBm25)} |`)
      lines.push(`| ${name} | hybrid by score (0.8 cos + 0.2 BM25) | ${kinds(level.hybridScore)} |`)
      lines.push(`| ${name} | adaptive hybrid | ${kinds(level.hybridAdaptive)} |`)
    }
  }
  lines.push(`| BM25 | — | — | lexical | ${kinds(bm25)} |`)
  lines.push(
    '',
    `onnxruntime threads: ${results[0]?.threads ?? '?'}. Mean tokens: passage ` +
      results.map((r) => `${r.repo.split('/')[1]} ${r.passageTokens.toFixed(0)}`).join(', ') +
      '; chunk ' +
      results.map((r) => `${r.repo.split('/')[1]} ${r.chunkTokens.toFixed(0)}`).join(', ') +
      '. Download = files in the cache; RAM = RSS of the model process (loaded = after loading; peak = maximum while indexing).',
  )
  return lines.join('\n')
}

async function main(): Promise<void> {
  const results: ModelMeasurement[] = []
  for (const target of targets) {
    console.error(`measuring ${target.repo}${target.dtype ? ` (${target.dtype})` : ''}…`)
    const result = await measureModel(target.repo, {
      cacheDir: cacheDir!,
      ...(target.dtype ? { dtype: target.dtype } : {}),
      ...(process.env.EVAL_THREADS ? { threads: Number(process.env.EVAL_THREADS) } : {}),
      log: (line) => console.error(line),
    })
    console.error(
      `  load ${result.loadMs} ms, RSS ${result.loadedRssMb}/${result.peakRssMb} MB, ` +
        `${result.chunksPerSecond.toFixed(1)} chunks/s, R@5 ${pct(result.levels[0]!.vector.all.recall5)}`,
    )
    results.push(result)
  }
  const report = markdown(results, bm25Only())
  console.log(report)
  if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, `${report}\n`)
  if (process.env.EVAL_JSON) writeFileSync(process.env.EVAL_JSON, JSON.stringify(results, null, 2))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
