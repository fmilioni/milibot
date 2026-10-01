import { DAEMON_VERSION } from '../config/paths'
import { migrate, type Migration } from './migrate'
import { type Db, openDatabase } from './sqlite'

interface MasterRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

/** `sqlite_master` as stable text (the committed `schema.sql` snapshots): lines trimmed, blank lines dropped. */
export function dumpSchema(db: Db): string {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as MasterRow[]
  return rows
    .map((row) => {
      const header = `-- ${row.type} ${row.name}${row.tbl_name === row.name ? '' : ` on ${row.tbl_name}`}`
      const sql = (row.sql ?? '')
        .split('\n')
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join('\n')
      return `${header}\n${sql};\n`
    })
    .join('\n')
}

/** Every `table.column` of the schema. */
function schemaColumns(db: Db): Set<string> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]
  const columns = new Set<string>()
  for (const { name } of tables) {
    for (const column of db.pragma(`table_info("${name.replaceAll('"', '""')}")`) as { name: string }[])
      columns.add(`${name}.${column.name}`)
  }
  return columns
}

/**
 * Dev builds only: a database whose tables differ from what its recorded version's migrations create was made by
 * a migration edited since, and would fail in confusing ways later.
 */
export function assertSchemaMatchesVersion(db: Db, migrations: readonly Migration[], path: string): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version === 0 || version > migrations.length) return
  const expected = openDatabase(':memory:')
  let wanted: Set<string>
  try {
    migrate(
      expected,
      migrations.filter((m) => m.version <= version),
    )
    wanted = schemaColumns(expected)
  } finally {
    expected.close()
  }
  const actual = schemaColumns(db)
  const missing = [...wanted].filter((c) => !actual.has(c))
  const extra = [...actual].filter((c) => !wanted.has(c))
  if (missing.length === 0 && extra.length === 0) return
  const differences = [
    ...missing.slice(0, 5).map((c) => `missing ${c}`),
    ...extra.slice(0, 5).map((c) => `unexpected ${c}`),
  ].join(', ')
  throw new Error(
    `Database ${path} was migrated by another draft of migration ${version} (${differences}). Delete ${path}` +
      (version === 1
        ? ''
        : ` or undo migration ${version} by hand and set PRAGMA user_version = ${version - 1}`),
  )
}

/** Opens and migrates a database file; running from sources, first checks it against its recorded version. */
export function openMigrated(
  path: string,
  migrations: readonly Migration[],
  checkSchema = DAEMON_VERSION === 'dev',
): Db {
  const db = openDatabase(path)
  try {
    if (checkSchema) assertSchemaMatchesVersion(db, migrations, path)
    migrate(db, migrations)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}
