import { ftsMatchExpression, searchTerms } from '@milibot/agent'
import type { ListPlansQuery, PlanExecution, PlanRevision, PlanStatus } from '@milibot/shared'

import { type Db, parseJson, sqlList } from '../../db/sqlite'
import { notFound } from '../../errors'

export interface PlanRow {
  seq: number
  id: string
  bot_id: string
  project_id: string | null
  conversation_id: string
  session_id: string | null
  title: string
  summary: string
  body: string
  revision: number
  execution: PlanExecution
  merge_pr: 0 | 1 | null
  model_spec: string | null
  folder: string | null
  status: PlanStatus
  feedback: string | null
  message_id: string | null
  created_at: number
  updated_at: number
  decided_at: number | null
  finished_at: number | null
  deleted_at: number | null
}

interface RevisionRow {
  plan_id: string
  revision: number
  title: string
  summary: string
  body: string
  steps: string
  feedback: string | null
  outcome: PlanRevision['outcome']
  message_id: string | null
  created_at: number
  decided_at: number | null
}

export interface NewPlan {
  id: string
  botId: string
  projectId: string | null
  conversationId: string
  title: string
  summary: string
  body: string
  execution: PlanExecution
  modelSpec: string | null
  folder: string | null
}

type RevisionSteps = Array<{ title: string; detail: string | null }>

/** The `plans` rows and their revisions (`plan_revisions`); the vectors are `search.ts`'s corpus. */
export class PlanStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /** Titles of the plans among `ids`, deleted ones left out. */
  names(ids: readonly string[]): Array<{ id: string; name: string }> {
    if (!ids.length) return []
    return this.db
      .prepare(`SELECT id, title AS name FROM plans WHERE id IN (${sqlList(ids)}) AND deleted_at IS NULL`)
      .all(...ids) as Array<{ id: string; name: string }>
  }

  row(id: string): PlanRow | null {
    return (
      (this.db.prepare('SELECT * FROM plans WHERE id = ? AND deleted_at IS NULL').get(id) as
        PlanRow | undefined) ?? null
    )
  }

  /** Also a deleted plan (a decision can arrive after the user deleted it). */
  rowWithDeleted(id: string): PlanRow | null {
    return (this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined) ?? null
  }

  requireRow(id: string): PlanRow {
    const row = this.row(id)
    if (!row) throw notFound('plan', id)
    return row
  }

  /** Every plan, newest first. */
  all(): PlanRow[] {
    return this.db
      .prepare('SELECT * FROM plans WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all() as PlanRow[]
  }

  withStatus(status: PlanStatus | null): PlanRow[] {
    return this.db
      .prepare(`SELECT * FROM plans WHERE deleted_at IS NULL ${status ? 'AND status = ?' : ''}`)
      .all(...(status ? [status] : [])) as PlanRow[]
  }

  /** The bot's approved or executing plans, newest first. */
  active(botId: string): PlanRow[] {
    return this.db
      .prepare(
        `SELECT * FROM plans WHERE bot_id = ? AND deleted_at IS NULL AND status IN ('approved', 'executing')
         ORDER BY updated_at DESC`,
      )
      .all(botId) as PlanRow[]
  }

  /** The bot's plans awaiting approval, approved or executing, oldest first. */
  unfinished(botId: string): PlanRow[] {
    return this.db
      .prepare(
        `SELECT * FROM plans WHERE bot_id = ? AND deleted_at IS NULL
         AND status IN ('awaiting_approval', 'approved', 'executing') ORDER BY created_at`,
      )
      .all(botId) as PlanRow[]
  }

  list(query: ListPlansQuery): PlanRow[] {
    const where = ['deleted_at IS NULL']
    const args: unknown[] = []
    if (query.status) {
      where.push('status = ?')
      args.push(query.status)
    }
    if (query.botId) {
      where.push('bot_id = ?')
      args.push(query.botId)
    }
    if (query.projectId === 'general') where.push('project_id IS NULL')
    else if (query.projectId) {
      where.push('project_id = ?')
      args.push(query.projectId)
    }
    const q = query.q?.trim()
    if (q) {
      const match = ftsMatchExpression(searchTerms(q))
      where.push(
        `(seq IN (SELECT rowid FROM plans_fts WHERE plans_fts MATCH ?) OR title LIKE ? OR summary LIKE ?)`,
      )
      const like = `%${q.replace(/[%_]/g, '')}%`
      args.push(match ?? '""', like, like)
    }
    return this.db
      .prepare(`SELECT * FROM plans WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 500`)
      .all(...args) as PlanRow[]
  }

  /** Plans a board card can link to, newest first. */
  linkTargets(): Array<{ id: string; title: string }> {
    return this.db
      .prepare('SELECT id, title FROM plans WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all() as Array<{ id: string; title: string }>
  }

  insertDraft(plan: NewPlan): PlanRow {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO plans (id, bot_id, project_id, conversation_id, title, summary, body, execution, model_spec,
           folder, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        plan.id,
        plan.botId,
        plan.projectId,
        plan.conversationId,
        plan.title,
        plan.summary,
        plan.body,
        plan.execution,
        plan.modelSpec,
        plan.folder,
        now,
        now,
      )
    return this.requireRow(plan.id)
  }

  update(id: string, patch: Partial<Omit<PlanRow, 'seq' | 'id'>>): PlanRow {
    const entries = Object.entries({ ...patch, updated_at: this.now() })
    this.db
      .prepare(`UPDATE plans SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id)
    return this.requireRow(id)
  }

  softDelete(id: string): void {
    const now = this.now()
    this.db.prepare('UPDATE plans SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
    this.db.prepare('DELETE FROM plan_vectors WHERE plan_id = ?').run(id)
  }

  revisions(planId: string): PlanRevision[] {
    return (
      this.db
        .prepare('SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision')
        .all(planId) as RevisionRow[]
    ).map((r) => ({
      revision: r.revision,
      title: r.title,
      summary: r.summary,
      body: r.body,
      steps: parseJson<RevisionSteps>(r.steps, []),
      feedback: r.feedback,
      outcome: r.outcome,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    }))
  }

  /** The revision the user decides on: the plan as it is now. */
  saveRevision(row: PlanRow, steps: RevisionSteps): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO plan_revisions (plan_id, revision, title, summary, body, steps, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.revision, row.title, row.summary, row.body, JSON.stringify(steps), this.now())
  }

  /** The pending revision follows a plan revised while it waits. */
  reviseRevision(row: PlanRow, steps: RevisionSteps): void {
    this.db
      .prepare(
        'UPDATE plan_revisions SET title = ?, summary = ?, body = ?, steps = ? WHERE plan_id = ? AND revision = ?',
      )
      .run(row.title, row.summary, row.body, JSON.stringify(steps), row.id, row.revision)
  }

  setRevisionMessage(planId: string, revision: number, messageId: string): void {
    this.db
      .prepare('UPDATE plan_revisions SET message_id = ? WHERE plan_id = ? AND revision = ?')
      .run(messageId, planId, revision)
  }

  decideRevision(row: PlanRow, outcome: NonNullable<PlanRevision['outcome']>, feedback: string | null): void {
    this.db
      .prepare(
        'UPDATE plan_revisions SET outcome = ?, feedback = ?, decided_at = ? WHERE plan_id = ? AND revision = ?',
      )
      .run(outcome, feedback, this.now(), row.id, row.revision)
  }

  /** Messages of every card the plan posted (one per submitted revision). */
  cardMessageIds(row: PlanRow): string[] {
    const ids = (
      this.db
        .prepare('SELECT message_id FROM plan_revisions WHERE plan_id = ? AND message_id IS NOT NULL')
        .all(row.id) as Array<{ message_id: string }>
    ).map((r) => r.message_id)
    return [...new Set([...ids, ...(row.message_id ? [row.message_id] : [])])]
  }
}
