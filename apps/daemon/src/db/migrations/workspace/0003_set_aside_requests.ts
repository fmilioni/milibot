import type { Migration } from '../../migrate'

/** Requests bots set aside (`after_current_work`) until their work in progress ends, kept across restarts. */
export default {
  version: 3,
  name: 'set_aside_requests',
  up: /* sql */ `
      CREATE TABLE set_aside_requests (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        task TEXT NOT NULL,
        -- JSON array: how the work it waits for was described when it was set aside.
        waiting_on TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'woken', 'dropped')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        woken_at INTEGER,
        -- Turns queued to wake the bot with it (a wake that never ran counts too).
        attempts INTEGER NOT NULL DEFAULT 0,
        -- When the idle watch reported the bot stopped with it; NULL = never.
        alerted_at INTEGER
      );
      CREATE INDEX set_aside_requests_waiting ON set_aside_requests (status, bot_id, created_at);
    `,
} satisfies Migration
