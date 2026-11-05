import type { Migration } from '../../migrate'

/**
 * computer: what the workspace's bots work on (`ComputerKind`). No CHECK, so new kinds need no table rebuild;
 * the app store parses it.
 */
export default {
  version: 2,
  name: 'workspace_computer',
  up: /* sql */ `
      ALTER TABLE workspaces ADD COLUMN computer TEXT NOT NULL DEFAULT 'vm';
    `,
} satisfies Migration
