export interface RankedList<Id> {
  ids: readonly Id[]
  /** Multiplies this list's contribution (default 1). */
  weight?: number
}

export interface FusedResult<Id> {
  id: Id
  score: number
  /** 1-based rank in each input list (null = absent), in input order. */
  ranks: Array<number | null>
}

/**
 * Reciprocal Rank Fusion: `score(d) = Σ weight / (k + rank(d))`. Ties keep the order of first
 * appearance (list 0 first), so the output is deterministic.
 */
export function reciprocalRankFusion<Id>(
  lists: ReadonlyArray<RankedList<Id> | readonly Id[]>,
  options: { k?: number; limit?: number } = {},
): FusedResult<Id>[] {
  const k = options.k ?? 60
  const fused = new Map<Id, FusedResult<Id> & { order: number }>()
  lists.forEach((entry, listIndex) => {
    const { ids, weight = 1 } = Array.isArray(entry)
      ? { ids: entry as readonly Id[], weight: 1 }
      : (entry as RankedList<Id>)
    const seen = new Set<Id>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const rank = seen.size
      let item = fused.get(id)
      if (!item) {
        item = { id, score: 0, ranks: lists.map(() => null), order: fused.size }
        fused.set(id, item)
      }
      item.score += weight / (k + rank)
      item.ranks[listIndex] = rank
    }
  })
  const sorted = [...fused.values()].sort((a, b) => b.score - a.score || a.order - b.order)
  return sorted.slice(0, options.limit ?? sorted.length).map(({ id, score, ranks }) => ({ id, score, ranks }))
}

/**
 * Weight of the full-text list when fusing it with the vector list (RRF, k = 60). Measured on the pt-BR
 * eval (`eval/knowledge`): with equal weights, incidental keyword matches of natural-language
 * questions push the right passage down (EmbeddingGemma R@1 97 → 71), and even 0.1 costs 13 points,
 * because RRF gaps between neighbouring ranks are tiny. Queries with identifiers (letters mixed with
 * digits like `E04`/`CC-310`, numbers of 3+ digits, paths, snake_case, CamelCase, quoted text) fuse
 * at full weight (it fixes e5's misses on codes); for prose, amounts and dates the weight is 0, so
 * full-text hits only fill the list after the vector hits.
 */
export function lexicalQueryWeight(query: string): number {
  const identifier =
    /\p{L}\d|\d\p{L}|\p{L}-\d|(?<![\d.,])\d{3,}(?![\d.,]*\d)|[/_\\]|"[^"]+"|\b\p{Ll}+\p{Lu}\w*/u.test(query)
  return identifier ? 1 : 0
}
