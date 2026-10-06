import {
  FINISHED_SESSION_STATUSES,
  type ListWorkSessionsQuery,
  type ModelChoice,
  type WorkSessionStatus,
} from '@milibot/shared'

import { modelSpecJson } from '../../db/model-spec'
import type { Db } from '../../db/sqlite'
import { notFound } from '../../errors'

export interface SessionRow {
  id: string
  bot_id: string
  conversation_id: string
  origin_conversation_id: string
  origin_message_id: string | null
  plan_id: string | null
  project_id: string | null
  title: string
  goal: string
  status: WorkSessionStatus
  cwd: string | null
  repo_name: string | null
  worktree_id: string | null
  base_commit: string | null
  shadow_git: string | null
  cli_generation: number
  model_spec: string | null
  result_summary: string | null
  /** The session that replaced this one (a new session of the same bot for the same work). */
  replaced_by: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
  deleted_at: number | null
  changes_json: string | null
  patches_at: number | null
  baseline_error: string | null
}

export interface SavedPatch {
  path: string
  patch: string
  truncated: boolean
}

export const isFinished = (status: WorkSessionStatus) => FINISHED_SESSION_STATUSES.includes(status)

/** The `work_sessions` rows and the other SQL of work sessions. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  row(id: string): SessionRow | null {
    return (
      (this.db.prepare('SELECT * FROM work_sessions WHERE id = ? AND deleted_at IS NULL').get(id) as
        SessionRow | undefined) ?? null
    )
  }

  requireRow(id: string): SessionRow {
    const row = this.row(id)
    if (!row) throw notFound('work session', id)
    return row
  }

  byConversation(conversationId: string): SessionRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM work_sessions WHERE conversation_id = ? AND deleted_at IS NULL')
        .get(conversationId) as SessionRow | undefined) ?? null
    )
  }

  update(id: string, patch: Partial<Omit<SessionRow, 'id'>>): SessionRow {
    const entries = Object.entries({ ...patch, updated_at: this.now() })
    this.db
      .prepare(`UPDATE work_sessions SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v), id)
    return this.requireRow(id)
  }

  list(query: ListWorkSessionsQuery): SessionRow[] {
    const where = ['deleted_at IS NULL']
    const args: unknown[] = []
    if (query.botId) {
      where.push('bot_id = ?')
      args.push(query.botId)
    }
    if (query.status) {
      where.push('status = ?')
      args.push(query.status)
    }
    if (query.projectId === 'general') where.push('project_id IS NULL')
    else if (query.projectId) {
      where.push('project_id = ?')
      args.push(query.projectId)
    }
    return this.db
      .prepare(`SELECT * FROM work_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`)
      .all(...args) as SessionRow[]
  }

  /** Sessions of the bot that have not ended. */
  open(botId: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM work_sessions WHERE bot_id = ? AND deleted_at IS NULL
         AND status NOT IN ('done', 'failed', 'cancelled')`,
      )
      .all(botId) as SessionRow[]
  }

  /** Folders of every bot's sessions that have not ended. */
  openFolders(): Array<{ cwd: string | null; title: string }> {
    return this.db
      .prepare(
        `SELECT cwd, title FROM work_sessions
         WHERE deleted_at IS NULL AND status NOT IN ('done', 'failed', 'cancelled')`,
      )
      .all() as Array<{ cwd: string | null; title: string }>
  }

  /** Folders of open sessions that run a plan. */
  openPlanFolders(): Array<{ cwd: string; planId: string }> {
    return this.db
      .prepare(
        `SELECT cwd, plan_id AS planId FROM work_sessions
         WHERE deleted_at IS NULL AND status NOT IN ('done', 'failed', 'cancelled')
           AND cwd IS NOT NULL AND plan_id IS NOT NULL`,
      )
      .all() as Array<{ cwd: string; planId: string }>
  }

  /** Sessions a board card can link to, newest first. */
  linkTargets(): Array<{ id: string; title: string }> {
    return this.db
      .prepare('SELECT id, title FROM work_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC')
      .all() as Array<{ id: string; title: string }>
  }

  countOpen(botId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM work_sessions
           WHERE bot_id = ? AND deleted_at IS NULL AND status NOT IN ('done', 'failed', 'cancelled')`,
        )
        .get(botId) as { n: number }
    ).n
  }

  insert(input: {
    id: string
    botId: string
    conversationId: string
    originConversationId: string
    planId: string | null
    projectId: string | null
    title: string
    goal: string
    cwd: string
    repoName: string | null
    model: ModelChoice | null
  }): SessionRow {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO work_sessions (id, bot_id, conversation_id, origin_conversation_id, plan_id, project_id, title,
           goal, status, cwd, repo_name, model_spec, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.botId,
        input.conversationId,
        input.originConversationId,
        input.planId,
        input.projectId,
        input.title,
        input.goal,
        input.cwd,
        input.repoName,
        modelSpecJson(input.model),
        now,
        now,
      )
    return this.requireRow(input.id)
  }

  /** Every lane is idle after a restart. */
  resetRunning(): void {
    this.db
      .prepare(
        `UPDATE work_sessions SET status = 'idle', updated_at = ?
         WHERE status IN ('running', 'preparing') AND deleted_at IS NULL`,
      )
      .run(this.now())
  }

  /** Soft-deletes the session and drops its transcript and saved patches. */
  delete(row: SessionRow): void {
    const now = this.now()
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE work_sessions SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, row.id)
      this.db.prepare('DELETE FROM session_transcript WHERE session_id = ?').run(row.id)
      this.db.prepare('DELETE FROM session_summaries WHERE session_id = ?').run(row.id)
      this.db.prepare('DELETE FROM work_session_patches WHERE session_id = ?').run(row.id)
    })()
  }

  /** Replaces the saved patches of a finished session. */
  savePatches(id: string, patches: readonly SavedPatch[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM work_session_patches WHERE session_id = ?').run(id)
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO work_session_patches (session_id, path, patch, truncated) VALUES (?, ?, ?, ?)',
      )
      for (const p of patches) insert.run(id, p.path, p.patch, p.truncated ? 1 : 0)
      this.db.prepare('UPDATE work_sessions SET patches_at = ? WHERE id = ?').run(this.now(), id)
    })()
  }

  savedPatch(id: string, path: string): SavedPatch | null {
    const row = this.db
      .prepare('SELECT path, patch, truncated FROM work_session_patches WHERE session_id = ? AND path = ?')
      .get(id, path) as { path: string; patch: string; truncated: number } | undefined
    return row ? { path: row.path, patch: row.patch, truncated: row.truncated === 1 } : null
  }
}
