import {
  ftsMatchExpression,
  type MemoryBackend,
  memoryConfig,
  type MessageSearchOptions,
  type NewSummary,
  type StoredMessage,
} from '@milibot/agent'
import {
  type ConversationMemorySummary,
  estimateTokens,
  MEMORY_SETTING_KEYS,
  type MemoryNote,
  type MemoryScope,
  type MemorySettings,
  newId,
  type ProjectView,
  SummaryModelSetting,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage, notFound } from '../../errors'
import { projectCondition } from '../knowledge/store'
import { type MessageRow, toMessage } from '../messages/store'

interface MemoryRow {
  seq: number
  id: string
  bot_id: string | null
  scope: MemoryScope
  project_id: string | null
  content: string
  pinned: number
  source_message_id: string | null
  token_count: number
  created_at: number
  updated_at: number
}

interface SummaryRow {
  id: string
  conversation_id: string
  bot_id: string | null
  level: number
  parent_id: string | null
  from_seq: number
  to_seq: number
  content: string
  token_count: number
  llm_call_id: string | null
  created_at: number
}

function toNote(row: MemoryRow): MemoryNote {
  return {
    id: row.id,
    scope: row.scope,
    botId: row.bot_id,
    projectId: row.project_id,
    content: row.content,
    pinned: row.pinned === 1,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSummary(row: SummaryRow): ConversationMemorySummary {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    botId: row.bot_id,
    level: row.level,
    parentId: row.parent_id,
    fromSeq: row.from_seq,
    toSeq: row.to_seq,
    content: row.content,
    tokenCount: row.token_count,
    llmCallId: row.llm_call_id,
    createdAt: row.created_at,
  }
}

function toStored(row: MessageRow): StoredMessage {
  return { ...toMessage(row), seq: row.seq }
}

/** `summaries` + `memories` (+ their FTS5 indexes and `messages_fts`) of workspace.db. */
export class MemoryStore implements MemoryBackend {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}

  pinnedNotes(botId: string): MemoryNote[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE scope = 'bot' AND pinned = 1 AND bot_id = ? ORDER BY created_at, seq",
      )
      .all(botId) as MemoryRow[]
    return rows.map(toNote)
  }

  workspaceNotes(): MemoryNote[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE scope = 'workspace' AND project_id IS NULL ORDER BY created_at, seq",
      )
      .all() as MemoryRow[]
    return rows.map(toNote)
  }

  projectNotes(projectId: string): MemoryNote[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE scope = 'workspace' AND project_id = ? ORDER BY created_at, seq")
      .all(projectId) as MemoryRow[]
    return rows.map(toNote)
  }

  botNotes(botId: string): MemoryNote[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE scope = 'bot' AND bot_id = ? ORDER BY created_at, seq")
      .all(botId) as MemoryRow[]
    return rows.map(toNote)
  }

  /** The bot's notes, newest first (bot settings). */
  listNotes(botId: string): MemoryNote[] {
    return this.botNotes(botId).reverse()
  }

  /** Workspace notes of every project, oldest first (the order they have in the context). */
  listWorkspaceNotes(): MemoryNote[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE scope = 'workspace' ORDER BY created_at, seq")
      .all() as MemoryRow[]
    return rows.map(toNote)
  }

  private checkProject(projectId: string | null | undefined): void {
    if (!projectId) return
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId))
      throw new DaemonError('not_found', `Unknown project ${projectId}`)
  }

  private byId(id: string): MemoryNote {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
    if (!row) throw notFound('memory', id)
    return toNote(row)
  }

  /** A note of `owner` (a bot id, or `workspace`); not found for anyone else's. */
  private note(owner: string, id: string): MemoryNote {
    const note = this.byId(id)
    const matches =
      owner === 'workspace' ? note.scope === 'workspace' : note.scope === 'bot' && note.botId === owner
    if (!matches) throw notFound('memory', id)
    return note
  }

  saveNote(input: {
    botId: string
    content: string
    pinned: boolean
    scope?: MemoryScope
    projectId?: string | null
    sourceMessageId?: string | null
  }): MemoryNote {
    const now = this.now()
    const scope = input.scope ?? 'bot'
    const botId = scope === 'workspace' ? null : input.botId
    const projectId = scope === 'workspace' ? (input.projectId ?? null) : null
    this.checkProject(projectId)
    const pinned = scope === 'workspace' || input.pinned
    const existing = this.db
      .prepare('SELECT * FROM memories WHERE scope = ? AND bot_id IS ? AND project_id IS ? AND content = ?')
      .get(scope, botId, projectId, input.content) as MemoryRow | undefined
    if (existing) {
      this.db
        .prepare('UPDATE memories SET pinned = MAX(pinned, ?), updated_at = ? WHERE id = ?')
        .run(pinned ? 1 : 0, now, existing.id)
      return this.byId(existing.id)
    }
    const id = newId('memory')
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, bot_id, project_id, content, pinned, source_message_id, token_count,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope,
        botId,
        projectId,
        input.content,
        pinned ? 1 : 0,
        input.sourceMessageId ?? null,
        estimateTokens(input.content),
        now,
        now,
      )
    return this.byId(id)
  }

  reviseNote(
    id: string,
    input: {
      content: string
      scope: MemoryScope
      botId: string
      projectId?: string | null
      absorbs?: string[]
    },
  ): MemoryNote {
    const current = this.byId(id)
    const workspace = input.scope === 'workspace'
    const projectId = workspace ? (input.projectId === undefined ? current.projectId : input.projectId) : null
    this.checkProject(projectId)
    const absorbs = [...new Set(input.absorbs ?? [])].filter((other) => other !== id)
    this.db.transaction(() => {
      this.deleteAll(absorbs)
      this.db
        .prepare(
          `UPDATE memories SET content = ?, scope = ?, bot_id = ?, project_id = ?,
           pinned = CASE WHEN ? THEN 1 ELSE pinned END, token_count = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.content,
          input.scope,
          workspace ? null : input.botId,
          projectId,
          workspace ? 1 : 0,
          estimateTokens(input.content),
          this.now(),
          id,
        )
    })()
    return this.byId(id)
  }

  forgetNotes(ids: string[]): void {
    this.db.transaction(() => this.deleteAll([...new Set(ids)]))()
  }

  private deleteAll(ids: string[]): void {
    const remove = this.db.prepare('DELETE FROM memories WHERE id = ?')
    for (const id of ids) if (remove.run(id).changes === 0) throw notFound('memory', id)
  }

  /** `owner`: the bot id, or `workspace` for a workspace note. */
  updateNote(
    owner: string,
    id: string,
    patch: { content?: string; pinned?: boolean; projectId?: string | null },
  ): MemoryNote {
    const current = this.note(owner, id)
    const content = patch.content ?? current.content
    const pinned = current.scope === 'workspace' || (patch.pinned ?? current.pinned)
    const projectId =
      current.scope === 'workspace' && patch.projectId !== undefined ? patch.projectId : current.projectId
    this.checkProject(projectId)
    this.db
      .prepare(
        'UPDATE memories SET content = ?, pinned = ?, project_id = ?, token_count = ?, updated_at = ? WHERE id = ?',
      )
      .run(content, pinned ? 1 : 0, projectId, estimateTokens(content), this.now(), id)
    return this.byId(id)
  }

  deleteNote(owner: string, id: string): void {
    this.note(owner, id)
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  searchNotes(botId: string, terms: string[], limit: number, project?: ProjectView): MemoryNote[] {
    const match = ftsMatchExpression(terms)
    if (!match) return []
    const inView = projectCondition(project, 'm.project_id')
    try {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.seq = f.rowid
           WHERE memories_fts MATCH ? AND (m.bot_id = ? OR (m.scope = 'workspace'${inView ? ` AND ${inView.sql}` : ''}))
           ORDER BY rank LIMIT ?`,
        )
        .all(match, botId, ...(inView?.values ?? []), limit) as MemoryRow[]
      return rows.map(toNote)
    } catch (err) {
      this.log('memory search failed', { match, err: errorMessage(err) })
      return []
    }
  }

  searchMessages(terms: string[], options: MessageSearchOptions): StoredMessage[] {
    const match = ftsMatchExpression(terms)
    if (!match) return []
    const exclude = options.excludeFrom ?? null
    try {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM messages_fts f
           JOIN messages m ON m.seq = f.rowid
           JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
           WHERE messages_fts MATCH ?
             AND m.kind IN ('text', 'activity')
             AND (m.payload IS NULL OR json_extract(m.payload, '$.streaming') IS NOT 1)
             AND (m.payload IS NULL OR json_extract(m.payload, '$.status') IS NOT 'running')
             AND m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE bot_id = ?)
             AND (? IS NULL OR m.conversation_id = ?)
             AND NOT (m.conversation_id = ? AND m.seq >= ?)
           ORDER BY rank LIMIT ?`,
        )
        .all(
          match,
          options.botId,
          options.conversationId ?? null,
          options.conversationId ?? null,
          exclude?.conversationId ?? '',
          exclude?.seq ?? 0,
          options.limit,
        ) as MessageRow[]
      return rows.map(toStored)
    } catch (err) {
      this.log('history search failed', { match, err: errorMessage(err) })
      return []
    }
  }

  messagesAfter(
    conversationId: string,
    afterSeq: number,
    options: { limit: number; newest?: boolean },
  ): StoredMessage[] {
    const rows = options.newest
      ? (this.db
          .prepare(
            `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?)
             ORDER BY seq`,
          )
          .all(conversationId, afterSeq, options.limit) as MessageRow[])
      : (this.db
          .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?')
          .all(conversationId, afterSeq, options.limit) as MessageRow[])
    return rows.map(toStored)
  }

  activeSummaries(botId: string, conversationId: string): ConversationMemorySummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM summaries WHERE bot_id = ? AND conversation_id = ? AND parent_id IS NULL
         ORDER BY from_seq, created_at`,
      )
      .all(botId, conversationId) as SummaryRow[]
    return rows.map(toSummary)
  }

  listSummaries(
    conversationId: string,
    options: { botId?: string; active?: boolean },
  ): ConversationMemorySummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM summaries WHERE conversation_id = ?
           AND (? IS NULL OR bot_id = ?) AND (? = 0 OR parent_id IS NULL)
         ORDER BY from_seq, level, created_at`,
      )
      .all(
        conversationId,
        options.botId ?? null,
        options.botId ?? null,
        options.active ? 1 : 0,
      ) as SummaryRow[]
    return rows.map(toSummary)
  }

  saveSummary(summary: NewSummary): ConversationMemorySummary {
    const id = newId('summary')
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO summaries (id, conversation_id, bot_id, level, parent_id, from_seq, to_seq, content, token_count,
             llm_call_id, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          summary.conversationId,
          summary.botId,
          summary.level,
          summary.fromSeq,
          summary.toSeq,
          summary.content,
          summary.tokenCount,
          summary.llmCallId,
          this.now(),
        )
      const adopt = this.db.prepare('UPDATE summaries SET parent_id = ? WHERE id = ? AND parent_id IS NULL')
      for (const child of summary.childIds) adopt.run(id, child)
      if (summary.level === 0) {
        this.db
          .prepare('UPDATE messages SET compacted = 1 WHERE conversation_id = ? AND seq BETWEEN ? AND ?')
          .run(summary.conversationId, summary.fromSeq, summary.toSeq)
      }
    })()
    return toSummary(this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow)
  }

  settings(getSetting: <T>(key: string, fallback: T) => T): MemorySettings {
    const config = memoryConfig(getSetting)
    const summaryModel = SummaryModelSetting.safeParse(
      getSetting<unknown>(MEMORY_SETTING_KEYS.summaryModel, null),
    )
    return {
      summaryModel: summaryModel.success ? summaryModel.data : null,
      tailBudgetTokens: config.tailBudgetTokens,
      memoryBudgetTokens: config.memoryBudgetTokens,
      workspaceMemoryBudgetTokens: config.workspaceMemoryBudgetTokens,
      summaryBudgetTokens: config.summaryBudgetTokens,
      retrievedBudgetTokens: config.retrievedBudgetTokens,
    }
  }
}
