/**
 * Minimal BM25 standing in for SQLite FTS5 (`unicode61 remove_diacritics 2`: case and accents folded,
 * split on anything that is not a letter or digit, no stemming) queried like the memory search:
 * `searchTerms` + `ftsMatchExpression` (any term, long words prefix-matched).
 */
import { foldText } from '@milibot/shared'

import { searchTerms, termPrefix } from '../../src/memory/search'

function ftsTokens(text: string): string[] {
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

export class Bm25 {
  private readonly docs: Array<{ id: string; tf: Map<string, number>; length: number }> = []
  private avgLength = 0

  constructor(
    items: Array<{ id: string; text: string }>,
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    for (const item of items) {
      const tokens = ftsTokens(item.text)
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      this.docs.push({ id: item.id, tf, length: tokens.length })
    }
    this.avgLength = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length)
  }

  private frequency(doc: { tf: Map<string, number> }, term: string): number {
    const prefix = termPrefix(term)
    if (!prefix) return doc.tf.get(term) ?? 0
    let f = 0
    for (const [token, count] of doc.tf) if (token.startsWith(prefix)) f += count
    return f
  }

  search(query: string, limit: number): Array<{ id: string; score: number }> {
    const terms = searchTerms(query).flatMap((t) => ftsTokens(t))
    const n = this.docs.length
    const scored = this.docs
      .map((doc) => {
        let score = 0
        for (const term of new Set(terms)) {
          const f = this.frequency(doc, term)
          if (!f) continue
          const df = this.docs.filter((d) => this.frequency(d, term) > 0).length
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
          score +=
            (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / this.avgLength))
        }
        return { id: doc.id, score }
      })
      .filter((d) => d.score > 0)
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}
