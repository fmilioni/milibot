import Database from 'better-sqlite3'

export type Db = Database.Database

export function openDatabase(path: string): Db {
  const db = new Database(path)
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}

/** A database another process owns (and may hold open in WAL), opened only to read. */
export function openReadonlyDb(path: string, busyTimeoutMs = 2000): Db {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma(`busy_timeout = ${busyTimeoutMs}`)
  return db
}

/** `read` on a read-only connection, or `fallback` when the database is missing, locked or unreadable. */
export function withReadonlyDb<T>(path: string, read: (db: Db) => T, fallback: T): T {
  let db: Db | null = null
  try {
    db = openReadonlyDb(path)
    return read(db)
  } catch {
    return fallback
  } finally {
    db?.close()
  }
}

export function bool(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** `?, ?, …` for an `IN (…)` over `values`. */
export function sqlList(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ')
}
