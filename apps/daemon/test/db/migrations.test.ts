import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { migrate, type Migration } from '../../src/db/migrate'
import { appMigrations } from '../../src/db/migrations/app'
import { workspaceMigrations } from '../../src/db/migrations/workspace'
import { assertSchemaMatchesVersion, dumpSchema } from '../../src/db/schema'
import { openDatabase } from '../../src/db/sqlite'

const MIGRATIONS_DIR = join(import.meta.dirname, '../../src/db/migrations')
const DATABASES = [
  ['app', appMigrations],
  ['workspace', workspaceMigrations],
] as const

function tableNames(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all() as { name: string }[]
  ).map((r) => r.name)
}

function workspaceDb() {
  const db = openDatabase(':memory:')
  migrate(db, workspaceMigrations)
  return db
}

function insertBot(db: ReturnType<typeof openDatabase>) {
  db.prepare(
    `INSERT INTO bots (id, name, slug, avatar_shape, avatar_color, avatar_eyes, linux_uid, display_num, created_at, updated_at)
     VALUES ('b1', 'Ana', 'ana', 'square', 'blue', 'capsule', 2001, 1, 1, 1)`,
  ).run()
}

describe('migrations', () => {
  it('creates the app schema and is idempotent', () => {
    const db = openDatabase(':memory:')
    expect(migrate(db, appMigrations).applied).toEqual(['1_init'])
    expect(migrate(db, appMigrations).applied).toEqual([])
    expect(tableNames(db)).toEqual(expect.arrayContaining(['workspaces', 'app_settings']))
    expect(db.pragma('user_version', { simple: true })).toBe(appMigrations.length)
  })

  it.each(DATABASES)('lists every %s migration file under its own version', async (name, migrations) => {
    const files = readdirSync(join(MIGRATIONS_DIR, name))
      .filter((file) => /^\d+_.+\.ts$/.test(file))
      .sort()
    expect(files.length).toBe(migrations.length)
    for (const [index, file] of files.entries()) {
      const { default: migration } = (await import(pathToFileURL(join(MIGRATIONS_DIR, name, file)).href)) as {
        default: Migration
      }
      expect(file).toBe(`${String(migration.version).padStart(4, '0')}_${migration.name}.ts`)
      expect(migrations[index]).toBe(migration)
    }
    expect(readdirSync(join(MIGRATIONS_DIR, name)).sort()).toEqual(
      [...files, 'index.ts', 'schema.sql'].sort(),
    )
  })

  it.each(DATABASES)('creates the %s schema in schema.sql (pnpm db:snapshot)', (name, migrations) => {
    const db = openDatabase(':memory:')
    migrate(db, migrations)
    expect(dumpSchema(db)).toBe(readFileSync(join(MIGRATIONS_DIR, name, 'schema.sql'), 'utf8'))
  })

  it('refuses a database whose tables differ from its version, naming the file to delete', () => {
    const db = openDatabase(':memory:')
    const baseline = workspaceMigrations.slice(0, 1)
    migrate(db, baseline)
    expect(() => assertSchemaMatchesVersion(db, baseline, 'ws.db')).not.toThrow()
    db.exec('ALTER TABLE bots ADD COLUMN stale INTEGER')
    expect(() => assertSchemaMatchesVersion(db, baseline, 'ws.db')).toThrow(
      /ws\.db was migrated by another draft of migration 1 \(unexpected bots\.stale\)\. Delete ws\.db$/,
    )
  })

  it('points at the draft migration when a later version differs', () => {
    const db = openDatabase(':memory:')
    const draft: Migration[] = [
      { version: 1, name: 'a', up: 'CREATE TABLE a (x INTEGER)' },
      { version: 2, name: 'b', up: 'CREATE TABLE b (x INTEGER)' },
    ]
    migrate(db, draft)
    const edited = [draft[0]!, { ...draft[1]!, up: 'CREATE TABLE b (x INTEGER, y INTEGER)' }]
    expect(() => assertSchemaMatchesVersion(db, edited, 'ws.db')).toThrow(
      /another draft of migration 2 \(missing b\.y\).*PRAGMA user_version = 1/,
    )
  })

  it('starts plans in their own folder and following the workspace merge choice', () => {
    const db = openDatabase(':memory:')
    migrate(db, workspaceMigrations)
    db.prepare(
      `INSERT INTO plans (id, bot_id, conversation_id, title, summary, body, status, created_at, updated_at)
       VALUES ('plan_1', 'bot_1', 'conv_1', 'T', 'S', 'B', 'approved', 1, 1)`,
    ).run()
    expect(db.prepare('SELECT folder, merge_pr FROM plans').get()).toEqual({ folder: null, merge_pr: null })
    db.prepare("UPDATE plans SET merge_pr = 1 WHERE id = 'plan_1'").run()
    expect(() => db.prepare("UPDATE plans SET merge_pr = 2 WHERE id = 'plan_1'").run()).toThrow()
  })

  it('keeps messages_fts in sync through triggers', () => {
    const db = workspaceDb()
    db.prepare(
      "INSERT INTO conversations (id, type, created_at, updated_at) VALUES ('c1', 'direct', 1, 1)",
    ).run()
    const insert = db.prepare(
      "INSERT INTO messages (id, conversation_id, author_type, content, created_at) VALUES (?, 'c1', 'user', ?, 1)",
    )
    // Portuguese on purpose: proves accent-insensitive matching
    insert.run('m1', 'Relatório de setembro com gráfico')
    insert.run('m2', 'Something else')
    const search = (q: string) =>
      (db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(q) as { rowid: number }[])
        .length
    expect(search('relatorio')).toBe(1)
    db.prepare("UPDATE messages SET content = 'nothing' WHERE id = 'm1'").run()
    expect(search('relatorio')).toBe(0)
    db.prepare("DELETE FROM messages WHERE id = 'm2'").run()
    expect(search('else')).toBe(0)
  })

  it('searches plans by title and summary', () => {
    const db = workspaceDb()
    // Portuguese on purpose: 'sessão' proves accent-insensitive matching
    db.prepare(
      `INSERT INTO plans (id, bot_id, conversation_id, title, summary, body, status, created_at, updated_at)
       VALUES ('plan_1', 'b1', 'c1', 'Refactor the login', 'Tokens no lugar da sessão', '', 'draft', 1, 1)`,
    ).run()
    const search = (term: string) =>
      (db.prepare('SELECT rowid FROM plans_fts WHERE plans_fts MATCH ?').all(term) as unknown[]).length
    expect(search('sessao')).toBe(1)
    db.prepare("UPDATE plans SET summary = 'Something else' WHERE id = 'plan_1'").run()
    expect(search('sessao')).toBe(0)
  })

  it('makes notes, conversations and plans general when their project is deleted', () => {
    const db = workspaceDb()
    db.prepare(
      "INSERT INTO projects (id, name, slug, created_at, updated_at) VALUES ('p1', 'Store', 'store', 1, 1)",
    ).run()
    db.prepare(
      "INSERT INTO conversations (id, type, project_id, created_at, updated_at) VALUES ('c1', 'direct', 'p1', 1, 1)",
    ).run()
    db.prepare(
      `INSERT INTO memories (id, scope, project_id, content, pinned, token_count, created_at, updated_at)
       VALUES ('m1', 'workspace', 'p1', 'note', 1, 1, 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO plans (id, bot_id, project_id, conversation_id, title, summary, body, status, created_at, updated_at)
       VALUES ('plan_1', 'b1', 'p1', 'c1', 'Plan', 'Summary', '', 'draft', 1, 1)`,
    ).run()
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run()
    for (const table of ['memories', 'conversations', 'plans'])
      expect(db.prepare(`SELECT project_id FROM ${table}`).get()).toEqual({ project_id: null })
  })

  it('removes a procedure with its steps and a skill with its per-bot switches', () => {
    const db = workspaceDb()
    insertBot(db)
    db.prepare(
      `INSERT INTO procedures (id, bot_id, taught_by_bot_id, name, status, created_at, updated_at)
       VALUES ('prc_1', 'b1', 'b1', 'Export PDF', 'ready', 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO procedure_steps (id, procedure_id, position, action, created_at)
       VALUES ('prs_1', 'prc_1', 1, 'Open the File menu', 1)`,
    ).run()
    expect(() =>
      db
        .prepare(
          "INSERT INTO procedure_steps (id, procedure_id, position, action, created_at) VALUES ('prs_2', 'nope', 1, 'x', 1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/)
    db.prepare('DELETE FROM procedures').run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM procedure_steps').get()).toEqual({ n: 0 })

    db.prepare(
      "INSERT INTO skills (id, slug, source, created_at, updated_at) VALUES ('prc_9', 'export-pdf', 'taught', 1, 1)",
    ).run()
    db.prepare(
      "INSERT INTO bot_skill_prefs (bot_id, skill_id, enabled, updated_at) VALUES ('b1', 'prc_9', 0, 1)",
    ).run()
    expect(db.prepare('SELECT allowed_bots, enabled FROM skills').get()).toEqual({
      allowed_bots: '"all"',
      enabled: 1,
    })
    db.prepare("DELETE FROM skills WHERE id = 'prc_9'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_skill_prefs').get()).toEqual({ n: 0 })
  })

  it('allows one active worktree per repository for the chat and one per session', () => {
    const db = workspaceDb()
    insertBot(db)
    const worktree = (sessionId: string | null, id: string) =>
      db
        .prepare(
          `INSERT INTO repo_worktrees (id, bot_id, repo_name, worktree_path, branch, status, created_at, session_id)
           VALUES (?, 'b1', 'app', '/w', 'b', 'active', 1, ?)`,
        )
        .run(id, sessionId)
    worktree(null, 'wt_chat')
    worktree('wses_1', 'wt_session')
    expect(() => worktree(null, 'wt_chat_2')).toThrow(/UNIQUE/)
    expect(() => worktree('wses_1', 'wt_session_2')).toThrow(/UNIQUE/)
  })

  it('orders existing boards by their last change when board positions arrive', () => {
    const db = openDatabase(':memory:')
    migrate(db, workspaceMigrations.slice(0, 3))
    const insert = db.prepare('INSERT INTO boards (id, title, created_at, updated_at) VALUES (?, ?, 1, ?)')
    insert.run('brd_a', 'Old', 10)
    insert.run('brd_b', 'Newest', 30)
    insert.run('brd_c', 'Middle', 20)
    insert.run('brd_d', 'Tie, made later', 20)
    migrate(db, workspaceMigrations.slice(0, 4))
    expect(db.prepare('SELECT id, position, doing_limit FROM boards ORDER BY position').all()).toEqual([
      { id: 'brd_b', position: 0, doing_limit: null },
      { id: 'brd_d', position: 1, doing_limit: null },
      { id: 'brd_c', position: 2, doing_limit: null },
      { id: 'brd_a', position: 3, doing_limit: null },
    ])
  })

  it('rolls back a failing migration and keeps the previous version', () => {
    const db = openDatabase(':memory:')
    const broken: Migration[] = [
      { version: 1, name: 'ok', up: 'CREATE TABLE a (x INTEGER)' },
      { version: 2, name: 'broken', up: 'CREATE TABLE b (x INTEGER); INSERT INTO missing VALUES (1);' },
    ]
    expect(() => migrate(db, broken)).toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect(tableNames(db)).not.toContain('b')
  })

  it('refuses a migration that would leave broken references', () => {
    const db = openDatabase(':memory:')
    const broken: Migration[] = [
      {
        version: 1,
        name: 'a',
        up: 'CREATE TABLE a (id TEXT PRIMARY KEY); CREATE TABLE b (a_id TEXT REFERENCES a (id));',
      },
      {
        version: 2,
        name: 'b',
        foreignKeysOff: true,
        up: "INSERT INTO b (a_id) VALUES ('missing')",
      },
    ]
    expect(() => migrate(db, broken)).toThrow(/broken foreign key/)
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('refuses a database newer than the code', () => {
    const db = openDatabase(':memory:')
    db.pragma('user_version = 99')
    expect(() => migrate(db, appMigrations)).toThrow(/newer/)
  })

  it('rejects non-contiguous versions', () => {
    const db = openDatabase(':memory:')
    expect(() => migrate(db, [{ version: 2, name: 'x', up: '' }])).toThrow(/contiguous/)
  })
})
