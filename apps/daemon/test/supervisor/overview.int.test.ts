import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Workspace } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { WorkspaceStore } from '../../src/runtime/workspace-store'
import { workspaceOverview } from '../../src/supervisor/overview'
import { openWorkspaceDb } from '../../src/workspace-db/open'
import { initWorkspaceDb } from '../../src/workspace-db/seed'
import { useTempDir } from '../support/temp'

const dir = useTempDir('overview')

const workspace = (): Workspace => ({
  id: 'ws_1',
  name: 'Personal',
  color: 'violet',
  icon: null,
  dir: dir(),
  closeBehavior: 'keep_running',
  createdAt: 1,
  lastOpenedAt: null,
  setup: 'done',
})

describe('workspace overview', () => {
  it('reads VM specs, disk use and bot/group counts from the workspace files', () => {
    expect(workspaceOverview(workspace())).toMatchObject({
      vmState: 'not_created',
      bots: 0,
      diskUsedBytes: null,
    })

    initWorkspaceDb(join(dir(), 'workspace.db'), 'en')
    const db = openWorkspaceDb(join(dir(), 'workspace.db'))
    const store = new WorkspaceStore(db)
    const ana = store.bots.create({ name: 'Ana' })
    const chief = store.bots.first()
    store.conversations.create({ type: 'group', botIds: [ana.id, chief?.id as string], title: 'Team' })
    db.close()

    mkdirSync(join(dir(), 'vm'))
    writeFileSync(join(dir(), 'vm', 'config.json'), JSON.stringify({ cpus: 6, memGb: 12, dataGb: 80 }))
    writeFileSync(join(dir(), 'vm', 'data.qcow2'), Buffer.alloc(64 * 1024, 1))
    expect(workspaceOverview(workspace())).toMatchObject({
      vmState: 'stopped',
      cpus: 6,
      memGb: 12,
      dataGb: 80,
      bots: 2,
      groups: 1,
      workingBots: 0,
    })
    expect(workspaceOverview(workspace()).diskUsedBytes).toBeGreaterThan(0)
  })
})
