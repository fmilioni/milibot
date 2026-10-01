import type { Db } from '../../db/sqlite'
import { type EmbeddingService, hybridSearch, sqlVectorCorpus, type VectorCorpus } from '../embeddings'

export const PLAN_CORPUS = 'plans'

/** Plan summaries (title + summary) as a corpus of the knowledge base's vector space. */
export function planCorpus(db: Db): VectorCorpus {
  return sqlVectorCorpus(db, {
    name: PLAN_CORPUS,
    itemsSql: 'SELECT id, title, summary FROM plans WHERE deleted_at IS NULL',
    text: (r) => `${r.title}\n${r.summary}`,
    vectors: { table: 'plan_vectors', idColumn: 'plan_id' },
    existsSql: 'EXISTS (SELECT 1 FROM plans WHERE id = ? AND deleted_at IS NULL)',
    liveJoin: 'JOIN plans p ON p.id = v.plan_id AND p.deleted_at IS NULL',
  })
}

/** Ids of the `candidates` (plan id by FTS rowid) matching `query`, best first. */
export function searchPlanIds(
  deps: { db: Db; embeddings: EmbeddingService },
  query: string,
  candidates: Map<number, string>,
  limit: number,
): Promise<string[]> {
  return hybridSearch(deps, query, {
    corpus: PLAN_CORPUS,
    fts: [{ table: 'plans_fts', ids: candidates }],
    limit,
  })
}
