import { newId, type Routine, type RoutineStatus } from '@milibot/shared'

import { type Db, sqlList } from '../../db/sqlite'

interface RoutineRow {
  id: string
  bot_id: string
  name: string
  cron: string
  prompt: string
  enabled: number
  last_run_at: number | null
  last_status: RoutineStatus | null
  next_run_at: number | null
  created_at: number
  updated_at: number
}

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface RoutineFields {
  name: string
  prompt: string
  cron: string
  enabled: boolean
  nextRunAt: number | null
}

/** The `routines` rows. */
export class RoutineStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Names of the routines among `ids`, with their bots. */
  names(ids: readonly string[]): Array<{ id: string; name: string; botId: string }> {
    if (!ids.length) return []
    return this.db
      .prepare(`SELECT id, name, bot_id AS botId FROM routines WHERE id IN (${sqlList(ids)})`)
      .all(...ids) as Array<{ id: string; name: string; botId: string }>
  }

  list(botId?: string): Routine[] {
    return (
      (botId
        ? this.db.prepare('SELECT * FROM routines WHERE bot_id = ? ORDER BY created_at').all(botId)
        : this.db.prepare('SELECT * FROM routines ORDER BY created_at').all()) as RoutineRow[]
    ).map(toRoutine)
  }

  find(id: string): Routine | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
    return row ? toRoutine(row) : null
  }

  /** Enabled routines whose next run is at or before `at`, earliest first. */
  due(at: number): Routine[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at',
        )
        .all(at) as RoutineRow[]
    ).map(toRoutine)
  }

  /** When the next enabled routine is due (null: none scheduled). */
  nextDue(): number | null {
    return (
      this.db
        .prepare('SELECT MIN(next_run_at) AS at FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL')
        .get() as { at: number | null }
    ).at
  }

  countForBot(botId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM routines WHERE bot_id = ?').get(botId) as { n: number }
    ).n
  }

  /** Runs left `running` by a previous runtime. */
  markInterrupted(): void {
    this.db
      .prepare(
        "UPDATE routines SET last_status = 'interrupted', updated_at = ? WHERE last_status = 'running'",
      )
      .run(this.now())
  }

  insert(botId: string, fields: RoutineFields): string {
    const id = newId('routine')
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO routines (id, bot_id, name, cron, prompt, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        botId,
        fields.name,
        fields.cron,
        fields.prompt,
        fields.enabled ? 1 : 0,
        fields.nextRunAt,
        now,
        now,
      )
    return id
  }

  update(id: string, fields: RoutineFields): void {
    this.db
      .prepare(
        'UPDATE routines SET name = ?, prompt = ?, cron = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(fields.name, fields.prompt, fields.cron, fields.enabled ? 1 : 0, fields.nextRunAt, this.now(), id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id)
  }

  setNext(id: string, next: number | null): void {
    this.db.prepare('UPDATE routines SET next_run_at = ? WHERE id = ?').run(next, id)
  }

  setStatus(id: string, status: RoutineStatus | null): void {
    this.db
      .prepare('UPDATE routines SET last_status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.now(), id)
  }

  markRunning(id: string): void {
    const now = this.now()
    this.db
      .prepare("UPDATE routines SET last_run_at = ?, last_status = 'running', updated_at = ? WHERE id = ?")
      .run(now, now, id)
  }
}
