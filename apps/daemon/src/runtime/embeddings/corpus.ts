import { ftsMatchExpression, searchTerms } from '@milibot/agent'
import {
  blobToInt8,
  int8ToBlob,
  lexicalQueryWeight,
  type QuantizedVector,
  reciprocalRankFusion,
} from '@milibot/agent/embeddings'

import type { Db } from '../../db/sqlite'
import type { EmbeddingService, VectorCorpus } from './service'

const RRF_K = 60
const PER_SOURCE = 30

export interface SqlCorpusSpec {
  name: string
  /** `SELECT id, title, summary …` of every item that should have a vector. */
  itemsSql: string
  text: (item: { title: string; summary: string }) => string
  /** The vectors table: `(<idColumn>, space, dims, vector, scale, sha256)`. */
  vectors: { table: string; idColumn: string }
  /** Condition an item must meet for its vector to be saved; each `?` is bound to the item's id. */
  existsSql: string
  /** Join (aliases: `v` for the vectors table) limiting the vectors read to live items. */
  liveJoin?: string
}

/** A corpus of summaries kept in SQL tables, embedded in the knowledge base's vector space. */
export function sqlVectorCorpus(db: Db, spec: SqlCorpusSpec): VectorCorpus {
  const { table, idColumn } = spec.vectors
  const existsParams = spec.existsSql.split('?').length - 1
  return {
    name: spec.name,
    items: () =>
      (db.prepare(spec.itemsSql).all() as Array<{ id: string; title: string; summary: string }>).map((r) => ({
        id: r.id,
        text: spec.text(r),
      })),
    shas: (space) =>
      new Map(
        (
          db.prepare(`SELECT ${idColumn} AS id, sha256 FROM ${table} WHERE space = ?`).all(space) as Array<{
            id: string
            sha256: string
          }>
        ).map((r) => [r.id, r.sha256]),
      ),
    save: (id, space, dims, vector, sha) => {
      db.prepare(
        `INSERT OR REPLACE INTO ${table} (${idColumn}, space, dims, vector, scale, sha256)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${spec.existsSql}`,
      ).run(
        id,
        space,
        dims,
        int8ToBlob(vector.data),
        vector.scale,
        sha,
        ...Array<string>(existsParams).fill(id),
      )
    },
    each: (space, visit) => {
      const rows = db
        .prepare(
          `SELECT v.${idColumn} AS id, v.vector, v.scale FROM ${table} v ${spec.liveJoin ?? ''} WHERE v.space = ?`,
        )
        .iterate(space) as IterableIterator<{ id: string; vector: Buffer; scale: number }>
      for (const r of rows) visit(r.id, { data: blobToInt8(r.vector), scale: r.scale } as QuantizedVector)
    },
    deleteSpacesExcept: (keep) => {
      db.prepare(`DELETE FROM ${table} WHERE space NOT IN (SELECT value FROM json_each(?))`).run(
        JSON.stringify(keep),
      )
    },
  }
}

/** A full-text table searched for the query, with the candidate id of each of its rowids. */
export interface FtsSource {
  table: string
  ids: Map<number, string>
}

/**
 * Ids among the candidates matching `query`, best first: each full-text source and the corpus's vectors
 * fused with weighted RRF (the text weighted by `lexicalQueryWeight` when a query vector exists).
 */
export async function hybridSearch(
  deps: { db: Db; embeddings: EmbeddingService },
  query: string,
  search: { corpus: string; fts: FtsSource[]; limit: number },
): Promise<string[]> {
  const match = ftsMatchExpression(searchTerms(query))
  const textIds = (source: FtsSource) =>
    match
      ? (
          deps.db
            .prepare(
              `SELECT rowid FROM ${source.table} WHERE ${source.table} MATCH ? ORDER BY bm25(${source.table}) LIMIT ${PER_SOURCE}`,
            )
            .all(match) as Array<{ rowid: number }>
        ).flatMap((r) => source.ids.get(r.rowid) ?? [])
      : []
  const vector = await deps.embeddings.queryVector(query, { timeoutMs: 10_000, loadModel: false })
  const allowed = new Set(search.fts.flatMap((source) => [...source.ids.values()]))
  const vectorIds = vector
    ? deps.embeddings.searchCorpus(search.corpus, vector, PER_SOURCE, allowed).map((h) => h.id)
    : []
  const lexical = vector ? lexicalQueryWeight(query) : 1
  return reciprocalRankFusion<string>(
    [
      { ids: vectorIds, weight: 1 },
      ...search.fts.map((source) => ({ ids: textIds(source), weight: lexical })),
    ],
    { k: RRF_K, limit: search.limit },
  ).map((f) => f.id)
}
