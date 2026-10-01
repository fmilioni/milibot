import type { Db } from '../db/sqlite'
import { secretKeyFor, type SecretStore } from '../secrets/secret-store'
import { readWorkspaceSetup, type Row, type SettingRow } from './readonly-queries'

function columns(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
}

function insertRows(target: Db, table: string, rows: Row[]): void {
  const allowed = columns(target, table)
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => allowed.has(k))
    target
      .prepare(
        `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      )
      .run(...keys.map((k) => row[k]))
  }
}

function writeSettings(target: Db, rows: SettingRow[]): void {
  const write = target.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  for (const row of rows) write.run(row.key, row.value, row.updated_at)
}

export interface CopyOptions {
  providers: boolean
  keys: boolean
  vmSize: boolean
}

/**
 * Copies providers (with their models and the model choices that use them), their API keys and the VM size
 * from another workspace into a freshly created one (no runtime owns it yet). The source is read-only: its
 * runtime may hold it open.
 */
export async function copyWorkspaceSetup(input: {
  sourceDb: string
  sourceWorkspaceId: string
  target: Db
  targetWorkspaceId: string
  secrets: SecretStore
  options: CopyOptions
}): Promise<void> {
  const { options } = input
  if (!options.providers && !options.vmSize) return
  const setup = readWorkspaceSetup(input.sourceDb, options)
  input.target.transaction(() => {
    insertRows(input.target, 'providers', setup.providers)
    insertRows(input.target, 'provider_models', setup.providerModels)
    writeSettings(input.target, setup.settings)
  })()
  if (!options.keys) return
  for (const { id } of setup.providers as { id: string }[]) {
    const secret = await input.secrets.get(input.sourceWorkspaceId, secretKeyFor(id))
    if (secret !== null) await input.secrets.set(input.targetWorkspaceId, secretKeyFor(id), secret)
  }
}
