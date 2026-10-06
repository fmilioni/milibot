import type { Migration } from '../../migrate'

/**
 * `repo_worktree_sessions`: the work sessions that checked out a bot's chat worktree (`repo_checkout` in a
 * session), so its cleanup waits until they end.
 */
export default {
  version: 6,
  name: 'repo_worktree_sessions',
  up: /* sql */ `
      CREATE TABLE repo_worktree_sessions (
        worktree_id TEXT NOT NULL REFERENCES repo_worktrees (id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        PRIMARY KEY (worktree_id, session_id)
      );
    `,
} satisfies Migration
