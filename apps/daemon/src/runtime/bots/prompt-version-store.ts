import { type AuthorType, lineDiff, newId, type PromptVersion } from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { notFound } from '../../errors'

export interface VersionRow {
  id: string
  bot_id: string
  text: string
  author_type: AuthorType
  author_bot_id: string | null
  reason: string | null
  diff: string
  added: number
  removed: number
  turn_id: string | null
  message_id: string | null
  created_at: number
}

export interface NewVersion {
  botId: string
  text: string
  authorType: AuthorType
  authorBotId: string | null
  reason: string | null
  /** Text of the previous version; null for the first one (no diff). */
  before: string | null
  turnId: string | null
  createdAt: number
}

export function toVersion(row: VersionRow, current: boolean): PromptVersion {
  return {
    id: row.id,
    botId: row.bot_id,
    text: row.text,
    authorType: row.author_type,
    authorBotId: row.author_bot_id,
    reason: row.reason,
    diff: row.diff,
    added: row.added,
    removed: row.removed,
    current,
    createdAt: row.created_at,
  }
}

/** The `bot_prompt_versions` rows: every persona a bot had. */
export class PromptVersionStore {
  constructor(private readonly db: Db) {}

  rows(botId: string): VersionRow[] {
    return this.db
      .prepare('SELECT * FROM bot_prompt_versions WHERE bot_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(botId) as VersionRow[]
  }

  row(id: string): VersionRow {
    const row = this.db.prepare('SELECT * FROM bot_prompt_versions WHERE id = ?').get(id) as
      VersionRow | undefined
    if (!row) throw notFound('prompt version', id)
    return row
  }

  hasAny(botId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM bot_prompt_versions WHERE bot_id = ? LIMIT 1').get(botId))
  }

  insert(input: NewVersion): VersionRow {
    const id = newId('promptVersion')
    const diff =
      input.before === null ? { diff: '', added: 0, removed: 0 } : lineDiff(input.before, input.text)
    this.db
      .prepare(
        `INSERT INTO bot_prompt_versions (id, bot_id, text, author_type, author_bot_id, reason, diff, added, removed,
           turn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.text,
        input.authorType,
        input.authorBotId,
        input.reason,
        diff.diff,
        diff.added,
        diff.removed,
        input.turnId,
        input.createdAt,
      )
    return this.row(id)
  }

  setMessage(versionId: string, messageId: string): void {
    this.db.prepare('UPDATE bot_prompt_versions SET message_id = ? WHERE id = ?').run(messageId, versionId)
  }

  /** Turn ids of the changes `authorId` made to `botId`'s persona since `since`. */
  botChangeTurns(botId: string, authorId: string, since: number): Array<string | null> {
    return (
      this.db
        .prepare(
          `SELECT turn_id FROM bot_prompt_versions
           WHERE bot_id = ? AND author_type = 'bot' AND author_bot_id = ? AND created_at >= ?`,
        )
        .all(botId, authorId, since) as Array<{ turn_id: string | null }>
    ).map((r) => r.turn_id)
  }

  /** The version right before `row` of the same bot. */
  previous(row: VersionRow): VersionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM bot_prompt_versions WHERE bot_id = ? AND (created_at < ? OR (created_at = ? AND rowid < (
           SELECT rowid FROM bot_prompt_versions WHERE id = ?)))
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(row.bot_id, row.created_at, row.created_at, row.id) as VersionRow | undefined
  }
}
