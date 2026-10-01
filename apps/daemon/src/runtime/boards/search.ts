import type { Db } from '../../db/sqlite'
import { type EmbeddingService, hybridSearch, sqlVectorCorpus, type VectorCorpus } from '../embeddings'

export const BOARD_CORPUS = 'boards'

/** Titles and summaries of boards and cards (ids `brd_`/`bcd_`) as a corpus of the knowledge base's space. */
export function boardCorpus(db: Db): VectorCorpus {
  return sqlVectorCorpus(db, {
    name: BOARD_CORPUS,
    itemsSql: 'SELECT id, title, summary FROM boards UNION ALL SELECT id, title, summary FROM board_cards',
    text: (r) => (r.summary ? `${r.title}\n${r.summary}` : r.title),
    vectors: { table: 'board_vectors', idColumn: 'item_id' },
    existsSql:
      'EXISTS (SELECT 1 FROM boards WHERE id = ?) OR EXISTS (SELECT 1 FROM board_cards WHERE id = ?)',
  })
}

/**
 * Ids of boards and cards among `candidates` matching `query`, best first. `candidates` maps each id to its
 * FTS rowid in its own table.
 */
export function searchBoardItems(
  deps: { db: Db; embeddings: EmbeddingService },
  query: string,
  candidates: { boards: Map<number, string>; cards: Map<number, string> },
  limit: number,
): Promise<string[]> {
  return hybridSearch(deps, query, {
    corpus: BOARD_CORPUS,
    fts: [
      { table: 'boards_fts', ids: candidates.boards },
      { table: 'board_cards_fts', ids: candidates.cards },
    ],
    limit,
  })
}
