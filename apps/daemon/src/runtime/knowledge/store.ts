import { blobToInt8, int8ToBlob } from '@milibot/agent/embeddings'
import {
  type BotScope,
  type KnowledgeDoc,
  type KnowledgeDocStatus,
  type KnowledgeKind,
  type KnowledgeSource,
  newId,
  type ProjectView,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { parseJson } from '../../db/sqlite'
import { notFound } from '../../errors'
import type { ChunkDraft } from './chunker'

export interface DocRow {
  seq: number
  id: string
  title: string
  file_name: string
  mime: string
  kind: KnowledgeKind
  source: KnowledgeSource
  source_ref: string | null
  author_type: 'user' | 'bot'
  author_bot_id: string | null
  conversation_id: string | null
  bytes: number
  sha256: string | null
  pages: number | null
  status: KnowledgeDocStatus
  error_code: string | null
  error: string | null
  progress: number
  summary: string | null
  summary_model: string | null
  summary_basis: string | null
  summary_stale: number
  ocr_pages: number
  pinned: number
  last_used_at: number | null
  scope: string
  project_id: string | null
  chunk_count: number
  created_at: number
  updated_at: number
  indexed_at: number | null
}

export interface ChunkRow {
  id: number
  doc_id: string
  seq: number
  page_from: number | null
  page_to: number | null
  heading: string
  text: string
  tokens: number
  sha256: string
  char_start: number
  char_end: number
}

export interface StoredVector {
  data: Int8Array
  scale: number
}

export interface NewDoc {
  title: string
  fileName: string
  mime: string
  kind: KnowledgeKind
  source: KnowledgeSource
  sourceRef?: string | null
  authorType: 'user' | 'bot'
  authorBotId?: string | null
  conversationId?: string | null
  bytes: number
  sha256?: string | null
  scope?: BotScope
  projectId?: string | null
  pinned?: boolean
  status?: KnowledgeDocStatus
}

export interface DocFilter {
  kind?: KnowledgeKind
  /** `user`, `bot` or a bot id. */
  author?: string
  status?: KnowledgeDocStatus
  pinned?: boolean
  /** Only documents this bot can see. */
  botId?: string
  /** Restrict to these ids (query results). */
  ids?: string[]
  /** Projects whose documents count (default: every project). */
  project?: ProjectView
}

export type DocPatch = Partial<{
  title: string
  fileName: string
  mime: string
  kind: KnowledgeKind
  sourceRef: string | null
  bytes: number
  sha256: string | null
  pages: number | null
  status: KnowledgeDocStatus
  errorCode: string | null
  error: string | null
  progress: number
  summary: string | null
  summaryModel: string | null
  summaryBasis: string | null
  summaryStale: boolean
  ocrPages: number
  pinned: boolean
  lastUsedAt: number | null
  scope: BotScope
  projectId: string | null
  chunkCount: number
  indexedAt: number | null
}>

const COLUMNS: Record<keyof DocPatch, string> = {
  title: 'title',
  fileName: 'file_name',
  mime: 'mime',
  kind: 'kind',
  sourceRef: 'source_ref',
  bytes: 'bytes',
  sha256: 'sha256',
  pages: 'pages',
  status: 'status',
  errorCode: 'error_code',
  error: 'error',
  progress: 'progress',
  summary: 'summary',
  summaryModel: 'summary_model',
  summaryBasis: 'summary_basis',
  summaryStale: 'summary_stale',
  ocrPages: 'ocr_pages',
  pinned: 'pinned',
  lastUsedAt: 'last_used_at',
  scope: 'scope',
  projectId: 'project_id',
  chunkCount: 'chunk_count',
  indexedAt: 'indexed_at',
}

/** SQL condition: the document is visible to bot `?`. */
const VISIBLE_TO_BOT = `(d.scope = '"all"' OR ? IN (SELECT value FROM json_each(d.scope)))`

/** SQL condition on `column` for a project view; null when every project counts. */
export function projectCondition(
  view: ProjectView | undefined,
  column = 'd.project_id',
): { sql: string; values: unknown[] } | null {
  switch (view?.mode) {
    case undefined:
    case 'any':
      return null
    case 'general':
      return { sql: `${column} IS NULL`, values: [] }
    case 'only':
      return { sql: `${column} = ?`, values: [view.projectId] }
    case 'default':
      return view.current
        ? { sql: `(${column} IS NULL OR ${column} = ?)`, values: [view.current] }
        : { sql: `${column} IS NULL`, values: [] }
  }
}

function parseScope(value: string): BotScope {
  const parsed = parseJson<unknown>(value, 'all')
  if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
  return 'all'
}

export function canSee(row: Pick<DocRow, 'scope'>, botId: string): boolean {
  const scope = parseScope(row.scope)
  return scope === 'all' || scope.includes(botId)
}

export function toDoc(row: DocRow, embedded: boolean): KnowledgeDoc {
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    mime: row.mime,
    kind: row.kind,
    source: row.source,
    sourceRef: row.source_ref,
    authorType: row.author_type,
    authorBotId: row.author_bot_id,
    conversationId: row.conversation_id,
    bytes: row.bytes,
    sha256: row.sha256,
    pages: row.pages,
    chunks: row.chunk_count,
    status: row.status,
    errorCode: row.error_code,
    error: row.error,
    progress: row.progress,
    summary: row.summary,
    summaryModel: row.summary_model,
    ocrPages: row.ocr_pages,
    pinned: row.pinned === 1,
    lastUsedAt: row.last_used_at,
    scope: parseScope(row.scope),
    projectId: row.project_id,
    embedded,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    indexedAt: row.indexed_at,
  }
}

/** SQL of the knowledge base (documents, chunks + FTS, vectors). */
export class KnowledgeStore {
  constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  insertDoc(input: NewDoc): DocRow {
    const id = newId('knowledgeDoc')
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO knowledge_docs (id, title, file_name, mime, kind, source, source_ref, author_type,
           author_bot_id, conversation_id, bytes, sha256, status, pinned, scope, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.fileName,
        input.mime,
        input.kind,
        input.source,
        input.sourceRef ?? null,
        input.authorType,
        input.authorBotId ?? null,
        input.conversationId ?? null,
        input.bytes,
        input.sha256 ?? null,
        input.status ?? 'queued',
        input.pinned ? 1 : 0,
        JSON.stringify(input.scope ?? 'all'),
        input.projectId ?? null,
        now,
        now,
      )
    return this.row(id)
  }

  find(id: string): DocRow | null {
    return (
      (this.db.prepare('SELECT * FROM knowledge_docs WHERE id = ?').get(id) as DocRow | undefined) ?? null
    )
  }

  row(id: string): DocRow {
    const row = this.find(id)
    if (!row) throw notFound('knowledge document', id)
    return row
  }

  update(id: string, patch: DocPatch, touch = true): DocRow {
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch) as Array<[keyof DocPatch, unknown]>) {
      if (value === undefined) continue
      sets.push(`${COLUMNS[key]} = ?`)
      values.push(
        key === 'scope' ? JSON.stringify(value) : typeof value === 'boolean' ? (value ? 1 : 0) : value,
      )
    }
    if (touch) {
      sets.push('updated_at = ?')
      values.push(this.now())
    }
    if (sets.length)
      this.db.prepare(`UPDATE knowledge_docs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    return this.row(id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(id)
  }

  bySource(source: KnowledgeSource, ref: string): DocRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM knowledge_docs WHERE source = ? AND source_ref = ? ORDER BY created_at DESC')
        .get(source, ref) as DocRow | undefined) ?? null
    )
  }

  all(): DocRow[] {
    return this.db.prepare('SELECT * FROM knowledge_docs ORDER BY created_at').all() as DocRow[]
  }

  withStatus(...statuses: KnowledgeDocStatus[]): DocRow[] {
    return this.db
      .prepare(
        `SELECT * FROM knowledge_docs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at`,
      )
      .all(...statuses) as DocRow[]
  }

  countByStatus(...statuses: KnowledgeDocStatus[]): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_docs WHERE status IN (${statuses.map(() => '?').join(', ')})`,
        )
        .get(...statuses) as { n: number }
    ).n
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_docs').get() as { n: number }).n
  }

  private where(filter: DocFilter): { sql: string; values: unknown[] } {
    const parts: string[] = []
    const values: unknown[] = []
    if (filter.kind) {
      parts.push('d.kind = ?')
      values.push(filter.kind)
    }
    if (filter.status) {
      parts.push('d.status = ?')
      values.push(filter.status)
    }
    if (filter.pinned !== undefined) {
      parts.push('d.pinned = ?')
      values.push(filter.pinned ? 1 : 0)
    }
    if (filter.author === 'user' || filter.author === 'bot') {
      parts.push('d.author_type = ?')
      values.push(filter.author)
    } else if (filter.author) {
      parts.push('d.author_bot_id = ?')
      values.push(filter.author)
    }
    if (filter.botId) {
      parts.push(VISIBLE_TO_BOT)
      values.push(filter.botId)
    }
    if (filter.ids) {
      parts.push(`d.id IN (SELECT value FROM json_each(?))`)
      values.push(JSON.stringify(filter.ids))
    }
    const project = projectCondition(filter.project)
    if (project) {
      parts.push(project.sql)
      values.push(...project.values)
    }
    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', values }
  }

  /** Pinned first, then most recently updated. */
  list(filter: DocFilter, page: { offset: number; limit: number }): { rows: DocRow[]; total: number } {
    const { sql, values } = this.where(filter)
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_docs d ${sql}`).get(...values) as { n: number }
    ).n
    const rows = this.db
      .prepare(
        `SELECT d.* FROM knowledge_docs d ${sql} ORDER BY d.pinned DESC, d.updated_at DESC, d.seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, page.limit, page.offset) as DocRow[]
    return { rows, total }
  }

  /** Ids of every document matching the filter (scope checks of searches). */
  ids(filter: DocFilter): string[] {
    const { sql, values } = this.where(filter)
    return (
      this.db.prepare(`SELECT d.id FROM knowledge_docs d ${sql}`).all(...values) as Array<{ id: string }>
    ).map((r) => r.id)
  }

  pinnedFor(botId: string, limit: number, view?: ProjectView): DocRow[] {
    const { sql, values } = this.where({ botId, pinned: true, project: view })
    return this.db
      .prepare(`SELECT d.* FROM knowledge_docs d ${sql} AND d.status != 'failed' ORDER BY d.seq LIMIT ?`)
      .all(...values, limit) as DocRow[]
  }

  countPinned(botId: string, view?: ProjectView): number {
    const { sql, values } = this.where({ botId, pinned: true, project: view })
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM knowledge_docs d ${sql} AND d.status != 'failed'`)
        .get(...values) as { n: number }
    ).n
  }

  countVisible(botId: string, view?: ProjectView): number {
    const { sql, values } = this.where({ botId, project: view })
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM knowledge_docs d ${sql} AND d.status != 'failed'`)
        .get(...values) as { n: number }
    ).n
  }

  /** Documents per project (null = general), for the project catalogs. */
  countByProject(): Map<string | null, number> {
    const rows = this.db
      .prepare(
        `SELECT project_id, COUNT(*) AS n FROM knowledge_docs WHERE status != 'failed' GROUP BY project_id`,
      )
      .all() as Array<{ project_id: string | null; n: number }>
    return new Map(rows.map((r) => [r.project_id, r.n]))
  }

  /** Full-text search over title, file name and summary; best first. */
  searchDocs(match: string, filter: DocFilter, limit: number): string[] {
    const { sql, values } = this.where(filter)
    const rows = this.db
      .prepare(
        `SELECT d.id FROM knowledge_docs_fts f JOIN knowledge_docs d ON d.seq = f.rowid
         ${sql ? `${sql} AND` : 'WHERE'} knowledge_docs_fts MATCH ?
         ORDER BY bm25(knowledge_docs_fts, 4.0, 2.0, 1.0) LIMIT ?`,
      )
      .all(...values, match, limit) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  markUsed(ids: string[]): void {
    if (!ids.length) return
    const update = this.db.prepare('UPDATE knowledge_docs SET last_used_at = ? WHERE id = ?')
    const now = this.now()
    this.db.transaction(() => {
      for (const id of new Set(ids)) update.run(now, id)
    })()
  }

  /** Documents that have chunks without a vector in `space`. */
  notEmbedded(space: string | null, docIds: string[]): Set<string> {
    if (!docIds.length) return new Set()
    if (!space) return new Set(docIds)
    const rows = this.db
      .prepare(
        `SELECT DISTINCT c.doc_id FROM knowledge_chunks c
         WHERE c.doc_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM knowledge_vectors v WHERE v.chunk_id = c.id AND v.space = ?)`,
      )
      .all(JSON.stringify(docIds), space) as Array<{ doc_id: string }>
    return new Set(rows.map((r) => r.doc_id))
  }

  chunks(docId: string): ChunkRow[] {
    return this.db
      .prepare('SELECT * FROM knowledge_chunks WHERE doc_id = ? ORDER BY seq')
      .all(docId) as ChunkRow[]
  }

  chunksByIds(ids: number[]): ChunkRow[] {
    if (!ids.length) return []
    return this.db
      .prepare('SELECT * FROM knowledge_chunks WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(ids)) as ChunkRow[]
  }

  chunkRange(docId: string, fromSeq: number, toSeq: number): ChunkRow[] {
    return this.db
      .prepare('SELECT * FROM knowledge_chunks WHERE doc_id = ? AND seq BETWEEN ? AND ? ORDER BY seq')
      .all(docId, fromSeq, toSeq) as ChunkRow[]
  }

  totalChunks(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get() as { n: number }).n
  }

  /**
   * Replaces the chunks of a document. A new chunk whose text hash matches a chunk already embedded
   * (in this or another document) gets a copy of its vectors instead of being embedded again.
   */
  replaceChunks(docId: string, drafts: ChunkDraft[]): { reused: number } {
    let reused = 0
    this.db.transaction(() => {
      const previous = this.db
        .prepare(
          `SELECT c.sha256, v.space, v.dims, v.vector, v.scale FROM knowledge_chunks c
           JOIN knowledge_vectors v ON v.chunk_id = c.id WHERE c.doc_id = ?`,
        )
        .all(docId) as Array<{ sha256: string; space: string; dims: number; vector: Buffer; scale: number }>
      const known = new Map<string, typeof previous>()
      for (const row of previous) known.set(row.sha256, [...(known.get(row.sha256) ?? []), row])
      this.db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docId)
      const insert = this.db.prepare(
        `INSERT INTO knowledge_chunks (doc_id, seq, page_from, page_to, heading, text, tokens, sha256, char_start, char_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const elsewhere = this.db.prepare(
        `SELECT v.space, v.dims, v.vector, v.scale FROM knowledge_chunks c
         JOIN knowledge_vectors v ON v.chunk_id = c.id WHERE c.sha256 = ?`,
      )
      const insertVector = this.db.prepare(
        'INSERT OR REPLACE INTO knowledge_vectors (chunk_id, space, dims, vector, scale) VALUES (?, ?, ?, ?, ?)',
      )
      for (const d of drafts) {
        const vectors =
          known.get(d.sha256) ??
          (elsewhere.all(d.sha256) as Array<{ space: string; dims: number; vector: Buffer; scale: number }>)
        const { lastInsertRowid } = insert.run(
          docId,
          d.seq,
          d.pageFrom,
          d.pageTo,
          d.heading,
          d.text,
          d.tokens,
          d.sha256,
          d.charStart,
          d.charEnd,
        )
        const seen = new Set<string>()
        for (const v of vectors) {
          if (seen.has(v.space)) continue
          seen.add(v.space)
          insertVector.run(Number(lastInsertRowid), v.space, v.dims, v.vector, v.scale)
        }
        if (vectors.length) reused++
      }
      this.db.prepare('UPDATE knowledge_docs SET chunk_count = ? WHERE id = ?').run(drafts.length, docId)
    })()
    return { reused }
  }

  /** Chunks without a vector in `space`, of one document or of every ready document. */
  chunksToEmbed(space: string, options: { docId?: string; limit: number }): ChunkRow[] {
    return this.db
      .prepare(
        `SELECT c.* FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id
         WHERE ${options.docId ? 'c.doc_id = ?' : "d.status = 'ready'"}
           AND NOT EXISTS (SELECT 1 FROM knowledge_vectors v WHERE v.chunk_id = c.id AND v.space = ?)
         ORDER BY c.id LIMIT ?`,
      )
      .all(...(options.docId ? [options.docId] : []), space, options.limit) as ChunkRow[]
  }

  countChunksToEmbed(space: string, docId?: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id
           WHERE ${docId ? 'c.doc_id = ?' : "d.status != 'failed'"}
             AND NOT EXISTS (SELECT 1 FROM knowledge_vectors v WHERE v.chunk_id = c.id AND v.space = ?)`,
        )
        .get(...(docId ? [docId] : []), space) as { n: number }
    ).n
  }

  vectorCount(space: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_vectors WHERE space = ?').get(space) as {
        n: number
      }
    ).n
  }

  /** Every FTS match of the chunks of the given documents (null = all), best first. */
  searchChunks(match: string, docIds: string[] | null, limit: number): Array<{ id: number; docId: string }> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.doc_id FROM knowledge_chunks_fts f JOIN knowledge_chunks c ON c.id = f.rowid
         WHERE knowledge_chunks_fts MATCH ? ${docIds ? 'AND c.doc_id IN (SELECT value FROM json_each(?))' : ''}
         ORDER BY bm25(knowledge_chunks_fts, 1.0, 0.5) LIMIT ?`,
      )
      .all(...[match, ...(docIds ? [JSON.stringify(docIds)] : []), limit]) as Array<{
      id: number
      doc_id: string
    }>
    return rows.map((r) => ({ id: r.id, docId: r.doc_id }))
  }

  insertVectors(space: string, dims: number, rows: Array<{ id: number; vector: StoredVector }>): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO knowledge_vectors (chunk_id, space, dims, vector, scale) VALUES (?, ?, ?, ?, ?)',
    )
    this.db.transaction(() => {
      for (const r of rows) insert.run(r.id, space, dims, int8ToBlob(r.vector.data), r.vector.scale)
    })()
  }

  eachVector(space: string, visit: (chunkId: number, docId: string, vector: StoredVector) => void): void {
    const rows = this.db
      .prepare(
        `SELECT v.chunk_id, c.doc_id, v.vector, v.scale FROM knowledge_vectors v
         JOIN knowledge_chunks c ON c.id = v.chunk_id WHERE v.space = ?`,
      )
      .iterate(space) as IterableIterator<{ chunk_id: number; doc_id: string; vector: Buffer; scale: number }>
    for (const row of rows)
      visit(row.chunk_id, row.doc_id, { data: blobToInt8(row.vector), scale: row.scale })
  }

  vectorsOf(chunkIds: number[], space: string): Map<number, StoredVector> {
    const out = new Map<number, StoredVector>()
    if (!chunkIds.length) return out
    const rows = this.db
      .prepare(
        'SELECT chunk_id, vector, scale FROM knowledge_vectors WHERE space = ? AND chunk_id IN (SELECT value FROM json_each(?))',
      )
      .all(space, JSON.stringify(chunkIds)) as Array<{ chunk_id: number; vector: Buffer; scale: number }>
    for (const r of rows) out.set(r.chunk_id, { data: blobToInt8(r.vector), scale: r.scale })
    return out
  }

  /** Removes the chunk vectors of every space not in `keep`; returns how many. */
  deleteSpacesExcept(keep: string[]): number {
    return this.db
      .prepare('DELETE FROM knowledge_vectors WHERE space NOT IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(keep)).changes
  }

  /** Documents interrupted mid-work (the runtime stopped) go back to the queue. */
  requeueInterrupted(): void {
    this.db
      .prepare(
        "UPDATE knowledge_docs SET status = 'queued', progress = 0 WHERE status IN ('extracting', 'summarizing')",
      )
      .run()
  }
}
