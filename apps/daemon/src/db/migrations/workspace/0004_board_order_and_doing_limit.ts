import type { Migration } from '../../migrate'

/**
 * Boards keep a fixed order (`position`, 0 = top), changed only by the user or a bot; until now the list
 * followed `updated_at`, which every card change moved. `doing_limit` caps the Doing column (NULL = none).
 */
export default {
  version: 4,
  name: 'board_order_and_doing_limit',
  up: /* sql */ `
      ALTER TABLE boards ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE boards ADD COLUMN doing_limit INTEGER;
      UPDATE boards SET position = (
        SELECT COUNT(*) FROM boards b
        WHERE b.updated_at > boards.updated_at OR (b.updated_at = boards.updated_at AND b.seq > boards.seq)
      );
      CREATE INDEX boards_position ON boards (position, seq);
    `,
} satisfies Migration
