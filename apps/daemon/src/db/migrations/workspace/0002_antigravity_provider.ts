import type { Migration } from '../../migrate'

/** Antigravity providers: `providers.type` gains `antigravity` (a CHECK constraint only changes with a rebuild). */
export default {
  version: 2,
  name: 'antigravity_provider',
  foreignKeysOff: true,
  up: /* sql */ `
      CREATE TABLE providers_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('openai_compatible', 'anthropic', 'claude_code', 'codex', 'antigravity')),
        name TEXT NOT NULL,
        preset TEXT,
        base_url TEXT,
        extra_headers TEXT NOT NULL DEFAULT '{}',
        config TEXT NOT NULL DEFAULT '{}',
        light_model TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO providers_new SELECT * FROM providers;
      DROP TABLE providers;
      ALTER TABLE providers_new RENAME TO providers;
      CREATE UNIQUE INDEX providers_single_default ON providers (is_default) WHERE is_default = 1;
    `,
} satisfies Migration
