import type { Migration } from '../../migrate'

/**
 * Worktrees removed automatically. `repo_worktree_sessions`: the work sessions that checked out a bot's chat
 * worktree (`repo_checkout` in a session), so its cleanup waits until they end. `work_sessions.patches_tree`:
 * where a finished session's files can be read once its folder is gone (JSON `SavedTree`).
 */
export default {
  version: 6,
  name: 'worktree_cleanup',
  up: /* sql */ `
      CREATE TABLE repo_worktree_sessions (
        worktree_id TEXT NOT NULL REFERENCES repo_worktrees (id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        PRIMARY KEY (worktree_id, session_id)
      );
      ALTER TABLE work_sessions ADD COLUMN patches_tree TEXT;
    `,
} satisfies Migration
