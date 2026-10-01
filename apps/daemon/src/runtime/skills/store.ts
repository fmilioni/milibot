import type { BotScope, SkillSource } from '@milibot/shared'

import type { Db } from '../../db/sqlite'

export interface SkillRow {
  id: string
  slug: string
  source: SkillSource
  source_json: string | null
  author_bot_id: string | null
  allowed_bots: string
  enabled: number
  error: string | null
  created_at: number
  updated_at: number
}

/** The `skills` row of a built-in or taught skill (created on first use; `slug` is `builtin:…`/`taught:…`). */
export function ensureSkillRow(db: Db, row: { id: string; slug: string; source: string }, now: number): void {
  db.prepare(
    `INSERT INTO skills (id, slug, source, allowed_bots, enabled, created_at, updated_at)
     VALUES (?, ?, ?, '"all"', 1, ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(row.id, row.slug, row.source, now, now)
}

/** A bot's own switch of a skill; `keep` leaves an existing switch as it is. */
export function setBotSkillPref(
  db: Db,
  pref: { botId: string; skillId: string; enabled: boolean },
  now: number,
  options: { keep?: boolean } = {},
): void {
  db.prepare(
    `INSERT INTO bot_skill_prefs (bot_id, skill_id, enabled, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (bot_id, skill_id) DO ${
       options.keep ? 'NOTHING' : 'UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at'
     }`,
  ).run(pref.botId, pref.skillId, pref.enabled ? 1 : 0, now)
}

/** The `skills` rows (the state of each skill; its folder is the content) and the bots' `bot_skill_prefs`. */
export class SkillStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  rows(): Map<string, SkillRow> {
    const rows = this.db.prepare('SELECT * FROM skills').all() as SkillRow[]
    return new Map(rows.map((r) => [r.id, r]))
  }

  /** Row of a built-in or taught skill, created on first use. */
  ensure(row: { id: string; slug: string; source: SkillSource }): SkillRow {
    ensureSkillRow(this.db, row, this.now())
    return this.db.prepare('SELECT * FROM skills WHERE id = ?').get(row.id) as SkillRow
  }

  insert(row: {
    id: string
    slug: string
    source: 'user' | 'import' | 'bot'
    allowed: BotScope
    originJson?: string | null
    authorBotId?: string | null
  }): SkillRow {
    const now = this.now()
    const inserted: SkillRow = {
      id: row.id,
      slug: row.slug,
      source: row.source,
      source_json: row.originJson ?? null,
      author_bot_id: row.authorBotId ?? null,
      allowed_bots: JSON.stringify(row.allowed),
      enabled: 1,
      error: null,
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        `INSERT INTO skills (id, slug, source, source_json, author_bot_id, allowed_bots, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        inserted.id,
        inserted.slug,
        inserted.source,
        inserted.source_json,
        inserted.author_bot_id,
        inserted.allowed_bots,
        now,
        now,
      )
    return inserted
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  }

  touch(id: string): void {
    this.db.prepare('UPDATE skills SET updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  setSwitch(id: string, enabled: number, allowedJson: string): void {
    this.db
      .prepare('UPDATE skills SET enabled = ?, allowed_bots = ?, updated_at = ? WHERE id = ?')
      .run(enabled, allowedJson, this.now(), id)
  }

  /** A folder skill replaced in place by an import (id and switches kept). */
  markImported(id: string, originJson: string, allowedJson: string): void {
    this.db
      .prepare(
        `UPDATE skills SET source = 'import', source_json = ?, allowed_bots = ?, updated_at = ? WHERE id = ?`,
      )
      .run(originJson, allowedJson, this.now(), id)
  }

  saveOrigin(id: string, originJson: string): void {
    this.db.prepare('UPDATE skills SET source_json = ? WHERE id = ?').run(originJson, id)
  }

  /** A bot saved a skill over this row: it becomes that bot's. */
  markBotOwned(id: string, botId: string, allowedJson: string): void {
    this.db
      .prepare(
        `UPDATE skills SET source = 'bot', author_bot_id = ?, allowed_bots = ?, updated_at = ? WHERE id = ?`,
      )
      .run(botId, allowedJson, this.now(), id)
  }

  prefs(botId: string): Map<string, boolean> {
    const rows = this.db
      .prepare('SELECT skill_id, enabled FROM bot_skill_prefs WHERE bot_id = ?')
      .all(botId) as Array<{ skill_id: string; enabled: number }>
    return new Map(rows.map((r) => [r.skill_id, r.enabled === 1]))
  }

  allPrefs(): Array<{ skillId: string; botId: string; enabled: boolean }> {
    return (
      this.db.prepare('SELECT skill_id, bot_id, enabled FROM bot_skill_prefs').all() as Array<{
        skill_id: string
        bot_id: string
        enabled: number
      }>
    ).map((r) => ({ skillId: r.skill_id, botId: r.bot_id, enabled: r.enabled === 1 }))
  }

  setPref(pref: { botId: string; skillId: string; enabled: boolean }): void {
    setBotSkillPref(this.db, pref, this.now())
  }
}
