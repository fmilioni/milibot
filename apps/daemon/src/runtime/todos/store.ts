import { newId, type PlanStep, type TodoStatus } from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { oneLine } from '../tools-core'
import { CHECKBOX } from './steps'

/** Step lists belong to a plan, or to a work session that runs without one. */
export type TodoOwner = 'plan' | 'session'

export interface TodoRow {
  id: string
  position: number
  title: string
  detail: string | null
  status: TodoStatus
  note: string | null
  updated_at: number
}

export interface TodoInput {
  id?: string
  title: string
  detail?: string | null
  status?: TodoStatus
  note?: string | null
}

function toStep(t: TodoRow): PlanStep {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    status: t.status,
    note: t.note,
    updatedAt: t.updated_at,
  }
}

/** The `todo_items` rows: the step lists of plans and of work sessions. */
export class TodoStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  rows(ownerType: TodoOwner, ownerId: string): TodoRow[] {
    return this.db
      .prepare('SELECT * FROM todo_items WHERE owner_type = ? AND owner_id = ? ORDER BY position, updated_at')
      .all(ownerType, ownerId) as TodoRow[]
  }

  steps(ownerType: TodoOwner, ownerId: string): PlanStep[] {
    return this.rows(ownerType, ownerId).map(toStep)
  }

  replace(ownerType: TodoOwner, ownerId: string, steps: TodoInput[]): void {
    const now = this.now()
    const insert = this.db.prepare(
      `INSERT INTO todo_items (id, owner_type, owner_id, position, title, detail, status, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM todo_items WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId)
      steps.forEach((s, i) =>
        insert.run(
          s.id ?? newId('todo'),
          ownerType,
          ownerId,
          i,
          s.title,
          s.detail ?? null,
          s.status ?? 'pending',
          s.note ?? null,
          now,
        ),
      )
    })()
  }

  /** The list as the bot reads it: checkbox, title, id and a one-line note. */
  text(ownerType: TodoOwner, ownerId: string): string {
    return this.rows(ownerType, ownerId)
      .map((t) => `${CHECKBOX[t.status]} ${t.title} (${t.id})${t.note ? ` — ${oneLine(t.note, 120)}` : ''}`)
      .join('\n')
  }
}
