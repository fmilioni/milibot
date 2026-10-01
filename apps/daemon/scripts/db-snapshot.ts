import { writeFileSync } from 'node:fs'

import { migrate } from '../src/db/migrate'
import { appMigrations } from '../src/db/migrations/app'
import { workspaceMigrations } from '../src/db/migrations/workspace'
import { dumpSchema } from '../src/db/schema'
import { openDatabase } from '../src/db/sqlite'

for (const [name, migrations] of [
  ['app', appMigrations],
  ['workspace', workspaceMigrations],
] as const) {
  const db = openDatabase(':memory:')
  migrate(db, migrations)
  const file = new URL(`../src/db/migrations/${name}/schema.sql`, import.meta.url)
  writeFileSync(file, dumpSchema(db))
  db.close()
  console.log(`wrote ${file.pathname}`)
}
