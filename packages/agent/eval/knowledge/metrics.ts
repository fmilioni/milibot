import type { EvalQuery, QueryKind } from './corpus'

export interface RetrievalMetrics {
  queries: number
  /** Top result answers the question. */
  hit1: number
  /** Share of the expected passages in the top 5 (averaged per query). */
  recall5: number
  /** 1 / rank of the first expected passage (0 when absent from the ranking). */
  mrr: number
}

export type MetricsByKind = Record<'all' | QueryKind, RetrievalMetrics>

function score(rankings: string[][], queries: EvalQuery[]): RetrievalMetrics {
  let hit1 = 0
  let recall5 = 0
  let mrr = 0
  queries.forEach((q, i) => {
    const ranking = rankings[i] ?? []
    if (q.expected.includes(ranking[0] ?? '')) hit1++
    const top5 = new Set(ranking.slice(0, 5))
    recall5 += q.expected.filter((id) => top5.has(id)).length / Math.min(5, q.expected.length)
    const first = ranking.findIndex((id) => q.expected.includes(id))
    mrr += first >= 0 ? 1 / (first + 1) : 0
  })
  const n = Math.max(1, queries.length)
  return { queries: queries.length, hit1: hit1 / n, recall5: recall5 / n, mrr: mrr / n }
}

export function evaluate(rankings: string[][], queries: EvalQuery[]): MetricsByKind {
  const byKind = (kind: QueryKind) => {
    const idx = queries.map((q, i) => (q.kind === kind ? i : -1)).filter((i) => i >= 0)
    return score(
      idx.map((i) => rankings[i]!),
      idx.map((i) => queries[i]!),
    )
  }
  return {
    all: score(rankings, queries),
    paraphrase: byKind('paraphrase'),
    exact: byKind('exact'),
    spread: byKind('spread'),
    crosslingual: byKind('crosslingual'),
  }
}
