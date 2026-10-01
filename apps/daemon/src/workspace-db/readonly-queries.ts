import { KNOWLEDGE_SETTING_KEYS, PREFERENCE_SETTING_KEYS, VM_SETTING_KEYS } from '@milibot/shared'

import { type Db, openReadonlyDb, withReadonlyDb } from '../db/sqlite'

/*
 * What the supervisor reads from a workspace database another process (its runtime) may hold open. The file
 * may belong to an older or newer app version, so these queries only use tables and columns of the baseline
 * migration (`0001_init`); a test runs them against a database migrated to it alone.
 */

export interface WorkspaceCounts {
  bots: number
  groups: number
  workingBots: number
}

/** Bot and group counts of the settings screen; zeros while the database is locked or being migrated. */
export function workspaceCounts(dbPath: string): WorkspaceCounts {
  return withReadonlyDb(
    dbPath,
    (db) => {
      const row = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM bots WHERE deleted_at IS NULL) AS bots,
             (SELECT COUNT(*) FROM bots WHERE deleted_at IS NULL AND status <> 'idle') AS working,
             (SELECT COUNT(*) FROM conversations WHERE type = 'group' AND deleted_at IS NULL) AS groups`,
        )
        .get() as { bots: number; working: number; groups: number }
      return { bots: row.bots, groups: row.groups, workingBots: row.working }
    },
    { bots: 0, groups: 0, workingBots: 0 },
  )
}

/** Enabled routines (0 when unreadable): whether the workspace has work to do in the background. */
export function countEnabledRoutines(dbPath: string): number {
  return withReadonlyDb(
    dbPath,
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM routines WHERE enabled = 1').get() as { n: number }).n,
    0,
  )
}

/** Model choices that point at providers (kept valid because provider ids are copied as they are). */
const PROVIDER_SETTING_KEYS = [
  PREFERENCE_SETTING_KEYS.newBotModel,
  PREFERENCE_SETTING_KEYS.triageModel,
  PREFERENCE_SETTING_KEYS.summaryModel,
  PREFERENCE_SETTING_KEYS.knowledgeSummaryModel,
  KNOWLEDGE_SETTING_KEYS.embedding,
  PREFERENCE_SETTING_KEYS.fallbackModel,
  PREFERENCE_SETTING_KEYS.imageModel,
]
// The `legacyOffice` switch rides along: it is part of what the VM holds.
const VM_SIZE_KEYS = [
  VM_SETTING_KEYS.cpus,
  VM_SETTING_KEYS.memGb,
  VM_SETTING_KEYS.dataGb,
  PREFERENCE_SETTING_KEYS.legacyOffice,
]

export type Row = Record<string, unknown>

export interface SettingRow {
  key: string
  value: string
  updated_at: number
}

/** What a new workspace copies from another one: whole provider rows and the settings that go with them. */
export interface WorkspaceSetupRows {
  providers: Row[]
  providerModels: Row[]
  settings: SettingRow[]
}

export function readWorkspaceSetup(
  dbPath: string,
  options: { providers: boolean; vmSize: boolean },
): WorkspaceSetupRows {
  const source = openReadonlyDb(dbPath, 5000)
  try {
    const keys = [
      ...(options.providers ? PROVIDER_SETTING_KEYS : []),
      ...(options.vmSize ? VM_SIZE_KEYS : []),
    ]
    return {
      providers: options.providers ? allRows(source, 'providers') : [],
      providerModels: options.providers ? allRows(source, 'provider_models') : [],
      settings: settingRows(source, keys),
    }
  } finally {
    source.close()
  }
}

function allRows(db: Db, table: 'providers' | 'provider_models'): Row[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Row[]
}

function settingRows(db: Db, keys: string[]): SettingRow[] {
  const read = db.prepare('SELECT key, value, updated_at FROM settings WHERE key = ?')
  return keys.flatMap((key) => (read.get(key) as SettingRow | undefined) ?? [])
}
