import { type Db, parseJson } from '../../db/sqlite'

/** The `settings` table: JSON values by key. */
export class SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined
    return row ? parseJson(row.value, fallback) : fallback
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), this.now())
  }

  delete(keys: readonly string[]): void {
    if (keys.length === 0) return
    this.db.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`).run(...keys)
  }

  /** Deletes the keys matching any of the LIKE `patterns` that also match `alsoLike`. */
  deleteLike(patterns: readonly string[], alsoLike: string): void {
    if (patterns.length === 0) return
    this.db
      .prepare(`DELETE FROM settings WHERE (${patterns.map(() => 'key LIKE ?').join(' OR ')}) AND key LIKE ?`)
      .run(...patterns, alsoLike)
  }

  /** Saves each field of `patch` that is set under its key in `keys`. */
  setMany<K extends string>(keys: Readonly<Record<K, string>>, patch: Partial<Record<K, unknown>>): void {
    for (const key of Object.keys(patch) as K[]) {
      if (patch[key] !== undefined) this.set(keys[key], patch[key])
    }
  }
}
