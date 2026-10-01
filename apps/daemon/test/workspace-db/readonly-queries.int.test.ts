import { join } from 'node:path'

import { VM_SETTING_KEYS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { migrate } from '../../src/db/migrate'
import { workspaceMigrations } from '../../src/db/migrations/workspace'
import { openDatabase } from '../../src/db/sqlite'
import { WorkspaceStore } from '../../src/runtime/workspace-store'
import {
  countEnabledRoutines,
  readWorkspaceSetup,
  workspaceCounts,
} from '../../src/workspace-db/readonly-queries'
import { seedWorkspace } from '../../src/workspace-db/seed'
import { useTempDir } from '../support/temp'

const dir = useTempDir('readonly-queries')

/** A workspace database as the baseline migration left it: what any app version can read. */
function baselineDb(): string {
  const path = join(dir(), 'workspace.db')
  const db = openDatabase(path)
  migrate(
    db,
    workspaceMigrations.filter((m) => m.version === 1),
  )
  const store = new WorkspaceStore(db)
  seedWorkspace(store, 'en')
  store.bots.create({ name: 'Iris' })
  const now = Date.now()
  db.prepare(
    `INSERT INTO providers (id, type, name, config, extra_headers, is_default, created_at, updated_at)
     VALUES ('provider_a', 'anthropic', 'Anthropic', '{}', '{}', 1, ?, ?)`,
  ).run(now, now)
  db.close()
  return path
}

describe("the supervisor's reads of a workspace database", () => {
  it('only use what the baseline migration created', () => {
    const path = baselineDb()
    expect(workspaceCounts(path)).toEqual({ bots: 2, groups: 0, workingBots: 0 })
    expect(countEnabledRoutines(path)).toBe(0)
    const setup = readWorkspaceSetup(path, { providers: true, vmSize: true })
    expect(setup.providers.map((p) => p.id)).toEqual(['provider_a'])
    expect(setup.settings.map((s) => s.key)).toContain(VM_SETTING_KEYS.cpus)
  })

  it('answer zeros for a database it cannot read', () => {
    expect(workspaceCounts(join(dir(), 'missing.db'))).toEqual({ bots: 0, groups: 0, workingBots: 0 })
    expect(countEnabledRoutines(join(dir(), 'missing.db'))).toBe(0)
  })
})
