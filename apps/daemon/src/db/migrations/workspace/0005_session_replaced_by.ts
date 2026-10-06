import type { Migration } from '../../migrate'

/** `replaced_by`: the session that replaced this one (a new session of the same bot for the same plan or card). */
export default {
  version: 5,
  name: 'session_replaced_by',
  up: /* sql */ `
      ALTER TABLE work_sessions ADD COLUMN replaced_by TEXT;
    `,
} satisfies Migration
