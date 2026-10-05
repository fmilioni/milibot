import { newId, type SetAsideRequest, type SetAsideStatus } from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'

interface SetAsideRow {
  id: string
  bot_id: string
  conversation_id: string
  task: string
  waiting_on: string
  status: SetAsideStatus
  created_at: number
  updated_at: number
  woken_at: number | null
  alerted_at: number | null
  attempts: number
  acted_at: number | null
}

function toRequest(row: SetAsideRow): SetAsideRequest {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    task: row.task,
    waitingOn: parseJson<string[]>(row.waiting_on, []),
    status: row.status,
    createdAt: row.created_at,
    wokenAt: row.woken_at,
    alertedAt: row.alerted_at,
    attempts: row.attempts,
    actedAt: row.acted_at,
  }
}

/** The `set_aside_requests` rows. */
export class SetAsideStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  add(entry: { botId: string; conversationId: string; task: string; waitingOn: string[] }): SetAsideRequest {
    const id = newId('setAside')
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO set_aside_requests (id, bot_id, conversation_id, task, waiting_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, entry.botId, entry.conversationId, entry.task, JSON.stringify(entry.waitingOn), now, now)
    return this.get(id) as SetAsideRequest
  }

  get(id: string): SetAsideRequest | null {
    const row = this.db.prepare('SELECT * FROM set_aside_requests WHERE id = ?').get(id) as
      SetAsideRow | undefined
    return row ? toRequest(row) : null
  }

  /** Oldest first (`rowid` breaks ties within one millisecond). */
  waiting(botId?: string): SetAsideRequest[] {
    const rows = (
      botId
        ? this.db
            .prepare(
              `SELECT * FROM set_aside_requests WHERE status = 'waiting' AND bot_id = ?
               ORDER BY created_at, rowid`,
            )
            .all(botId)
        : this.db
            .prepare(`SELECT * FROM set_aside_requests WHERE status = 'waiting' ORDER BY created_at, rowid`)
            .all()
    ) as SetAsideRow[]
    return rows.map(toRequest)
  }

  markWoken(id: string): SetAsideRequest | null {
    const now = this.now()
    this.db
      .prepare(
        `UPDATE set_aside_requests SET status = 'woken', woken_at = ?, updated_at = ?
         WHERE id = ? AND status = 'waiting'`,
      )
      .run(now, now, id)
    return this.get(id)
  }

  markActed(id: string): SetAsideRequest | null {
    const now = this.now()
    this.db
      .prepare(
        `UPDATE set_aside_requests SET acted_at = ?, updated_at = ?
         WHERE id = ? AND status = 'waiting' AND acted_at IS NULL`,
      )
      .run(now, now, id)
    return this.get(id)
  }

  markAttempt(id: string): void {
    this.db
      .prepare('UPDATE set_aside_requests SET attempts = attempts + 1, updated_at = ? WHERE id = ?')
      .run(this.now(), id)
  }

  markAlerted(ids: string[]): void {
    const now = this.now()
    const update = this.db.prepare(
      'UPDATE set_aside_requests SET alerted_at = ?, updated_at = ? WHERE id = ?',
    )
    this.db.transaction(() => {
      for (const id of ids) update.run(now, now, id)
    })()
  }

  /** Drops the waiting requests matching every field given (at least one). Returns the dropped ones. */
  drop(filter: { id?: string; botId?: string; conversationId?: string }): SetAsideRequest[] {
    const where = ["status = 'waiting'"]
    const args: string[] = []
    for (const [column, value] of [
      ['id', filter.id],
      ['bot_id', filter.botId],
      ['conversation_id', filter.conversationId],
    ] as const) {
      if (!value) continue
      where.push(`${column} = ?`)
      args.push(value)
    }
    if (args.length === 0) return []
    const rows = this.db
      .prepare(`SELECT * FROM set_aside_requests WHERE ${where.join(' AND ')}`)
      .all(...args) as SetAsideRow[]
    if (rows.length === 0) return []
    const now = this.now()
    const update = this.db.prepare(
      "UPDATE set_aside_requests SET status = 'dropped', updated_at = ? WHERE id = ?",
    )
    this.db.transaction(() => {
      for (const row of rows) update.run(now, row.id)
    })()
    return rows.map((row) => toRequest({ ...row, status: 'dropped' }))
  }
}
