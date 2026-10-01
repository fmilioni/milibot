import { type ChunkCorpus, sqlVectorCorpus } from '../embeddings'
import { embeddingText } from './chunker'
import type { ChunkRow, KnowledgeStore } from './store'

/** The corpus of the documents' summary vectors (title + summary). */
export const SUMMARY_CORPUS = 'knowledge_docs'

/** Chunks as the embedding service keeps them in its loaded indexes. */
export function chunkRefs(rows: ChunkRow[]): Array<{ id: number; docId: string }> {
  return rows.map((c) => ({ id: c.id, docId: c.doc_id }))
}

/** The knowledge base in the vector space: its chunks, and a summary vector per summarized document. */
export function knowledgeCorpus(store: KnowledgeStore): ChunkCorpus {
  return {
    summaries: sqlVectorCorpus(store.db, {
      name: SUMMARY_CORPUS,
      itemsSql:
        "SELECT id, title, summary FROM knowledge_docs WHERE summary IS NOT NULL AND summary != '' AND status != 'failed'",
      text: (doc) => `${doc.title}\n${doc.summary}`,
      vectors: { table: 'knowledge_doc_vectors', idColumn: 'doc_id' },
      existsSql: 'EXISTS (SELECT 1 FROM knowledge_docs WHERE id = ?)',
    }),
    total: () => store.totalChunks(),
    pendingCount: (space, docId) => store.countChunksToEmbed(space, docId),
    pending: (space, options) =>
      store
        .chunksToEmbed(space, options)
        .map((c) => ({ id: c.id, docId: c.doc_id, text: embeddingText(c.heading, c.text) })),
    save: (space, dims, rows) => store.insertVectors(space, dims, rows),
    vectors: (ids, space) => store.vectorsOf(ids, space),
    each: (space, visit) => store.eachVector(space, visit),
    vectorCount: (space) => store.vectorCount(space),
    exists: (docId) => store.find(docId) !== null,
    deleteSpacesExcept: (keep) => store.deleteSpacesExcept(keep),
  }
}
