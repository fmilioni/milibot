import { workspaceMigrations } from '../db/migrations/workspace'
import { openMigrated } from '../db/schema'
import type { Db } from '../db/sqlite'

export function openWorkspaceDb(path: string): Db {
  return openMigrated(path, workspaceMigrations)
}
