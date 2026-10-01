import type { Db } from './sqlite'

export interface Migration {
  version: number
  name: string
  up: string | ((db: Db) => void)
  /**
   * Runs with foreign key enforcement off (a table rebuild: `DROP TABLE` would otherwise cascade into
   * every table referencing it). The pragma cannot change inside a transaction, so it is switched around
   * it, and the migration fails unless `foreign_key_check` finds nothing broken.
   */
  foreignKeysOff?: true
}

export interface MigrationResult {
  from: number
  to: number
  applied: string[]
}

/** The database was written by a newer app version (its schema version is past this code's last migration). */
export class NewerSchemaError extends Error {
  constructor(
    readonly version: number,
    readonly supported: number,
  ) {
    super(`Database schema version ${version} is newer than supported version ${supported}`)
    this.name = 'NewerSchemaError'
  }
}

/**
 * Applies pending migrations in order, each inside its own transaction, tracking the schema
 * version in `PRAGMA user_version`. Refuses to open a database newer than the code.
 */
export function migrate(db: Db, migrations: readonly Migration[]): MigrationResult {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  sorted.forEach((m, index) => {
    if (m.version !== index + 1)
      throw new Error(`Migration versions must be contiguous from 1; got ${m.version}`)
  })
  const from = db.pragma('user_version', { simple: true }) as number
  const latest = sorted.at(-1)?.version ?? 0
  if (from > latest) {
    throw new NewerSchemaError(from, latest)
  }
  const applied: string[] = []
  for (const migration of sorted) {
    if (migration.version <= from) continue
    const enforced = migration.foreignKeysOff && db.pragma('foreign_keys', { simple: true }) === 1
    if (enforced) db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        if (typeof migration.up === 'string') db.exec(migration.up)
        else migration.up(db)
        if (migration.foreignKeysOff) {
          const broken = db.pragma('foreign_key_check') as unknown[]
          if (broken.length)
            throw new Error(
              `Migration ${migration.version} left ${broken.length} broken foreign key reference(s)`,
            )
        }
        db.pragma(`user_version = ${migration.version}`)
      })()
    } finally {
      if (enforced) db.pragma('foreign_keys = ON')
    }
    applied.push(`${migration.version}_${migration.name}`)
  }
  return { from, to: latest, applied }
}
