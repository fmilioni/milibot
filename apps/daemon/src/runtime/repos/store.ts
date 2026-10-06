import { newId } from '@milibot/shared'

import type { Db } from '../../db/sqlite'

export interface WorktreeRow {
  id: string
  botId: string
  repoName: string
  repoUrl: string | null
  worktreePath: string
  branch: string
  baseBranch: string | null
  /** Work session the worktree belongs to (null: the bot's chat worktree). */
  sessionId: string | null
  status: 'active' | 'released'
  createdAt: number
}

/** The `repo_worktrees` table: the checkouts bots work in. */
export class WorktreeStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private toWorktree(r: Record<string, unknown>): WorktreeRow {
    return {
      id: r.id as string,
      botId: r.bot_id as string,
      repoName: r.repo_name as string,
      repoUrl: (r.repo_url as string | null) ?? null,
      worktreePath: r.worktree_path as string,
      branch: r.branch as string,
      baseBranch: (r.base_branch as string | null) ?? null,
      sessionId: (r.session_id as string | null) ?? null,
      status: r.status as WorktreeRow['status'],
      createdAt: r.created_at as number,
    }
  }

  active(botId: string, repoName: string): WorktreeRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM repo_worktrees
         WHERE bot_id = ? AND repo_name = ? AND status = 'active' AND session_id IS NULL`,
      )
      .get(botId, repoName) as Record<string, unknown> | undefined
    return row ? this.toWorktree(row) : null
  }

  get(id: string): WorktreeRow | null {
    const row = this.db.prepare('SELECT * FROM repo_worktrees WHERE id = ?').get(id) as
      Record<string, unknown> | undefined
    return row ? this.toWorktree(row) : null
  }

  listActive(): WorktreeRow[] {
    return (
      this.db
        .prepare("SELECT * FROM repo_worktrees WHERE status = 'active' ORDER BY repo_name, created_at")
        .all() as Record<string, unknown>[]
    ).map((r) => this.toWorktree(r))
  }

  insert(
    input: Omit<WorktreeRow, 'id' | 'status' | 'createdAt' | 'sessionId'> & { sessionId?: string | null },
  ): WorktreeRow {
    const id = newId('worktree')
    this.db
      .prepare(
        `INSERT INTO repo_worktrees (id, bot_id, repo_name, repo_url, worktree_path, branch, base_branch, status,
           created_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        input.botId,
        input.repoName,
        input.repoUrl,
        input.worktreePath,
        input.branch,
        input.baseBranch,
        this.now(),
        input.sessionId ?? null,
      )
    return this.get(id) as WorktreeRow
  }

  /** The worktree is gone; `branch` = the one it was on at the end, when known. */
  release(id: string, options: { branch?: string } = {}): void {
    this.db
      .prepare(
        "UPDATE repo_worktrees SET status = 'released', released_at = ?, branch = coalesce(?, branch) WHERE id = ?",
      )
      .run(this.now(), options.branch || null, id)
  }

  /** The branch checked out in it now (a bot renamed it or switched). */
  setBranch(id: string, branch: string): void {
    this.db.prepare('UPDATE repo_worktrees SET branch = ? WHERE id = ?').run(branch, id)
  }

  /** A released worktree made again at the same path (a session that reopened). */
  reactivate(id: string): void {
    this.db.prepare("UPDATE repo_worktrees SET status = 'active', released_at = NULL WHERE id = ?").run(id)
  }
}
