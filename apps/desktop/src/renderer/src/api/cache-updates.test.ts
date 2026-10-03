import type { BackupJob, Routine, WorkspaceEvent } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { appCacheUpdates, applyCacheUpdates, workspaceCacheUpdates } from './cache-updates'
import { queryKeys } from './queries'
import { createQueryClient } from './query-client'

const routine = (id: string, name: string) => ({ id, botId: 'bot_1', name }) as Routine

describe('workspace cache updates', () => {
  it('patches a loaded routine list in place and leaves an unloaded one alone', () => {
    const client = createQueryClient()
    const key = queryKeys.routines('ws1', 'bot_1')
    client.setQueryData(key, [routine('r1', 'Old')])
    const event = (name: string, id = 'r1'): WorkspaceEvent => ({
      type: 'routine.updated',
      payload: { routine: routine(id, name) },
    })
    applyCacheUpdates(client, workspaceCacheUpdates('ws1', event('New')))
    applyCacheUpdates(client, workspaceCacheUpdates('ws1', event('Added', 'r2')))
    expect(client.getQueryData<Routine[]>(key)?.map((r) => r.name)).toEqual(['New', 'Added'])
    applyCacheUpdates(
      client,
      workspaceCacheUpdates('ws1', { type: 'routine.deleted', payload: { routineId: 'r1', botId: 'bot_1' } }),
    )
    expect(client.getQueryData<Routine[]>(key)?.map((r) => r.id)).toEqual(['r2'])
    applyCacheUpdates(client, workspaceCacheUpdates('ws2', event('Elsewhere')))
    expect(client.getQueryData(queryKeys.routines('ws2', 'bot_1'))).toBeUndefined()
  })

  it('writes the data an event carries', () => {
    const client = createQueryClient()
    const job = { id: 'job_1', status: 'running' } as BackupJob
    applyCacheUpdates(client, workspaceCacheUpdates('ws1', { type: 'backup.job', payload: { job } }))
    expect(client.getQueryData(queryKeys.backupJob('ws1'))).toBe(job)
  })

  it('makes stale what the event changed, and nothing for events stores follow', () => {
    const client = createQueryClient()
    client.setQueryData(queryKeys.boardCard('ws1', 'brd_1', 'crd_1'), { id: 'crd_1' })
    client.setQueryData(queryKeys.boardCard('ws1', 'brd_2', 'crd_2'), { id: 'crd_2' })
    applyCacheUpdates(
      client,
      workspaceCacheUpdates('ws1', { type: 'board.cards.updated', payload: { boardId: 'brd_1', cards: [] } }),
    )
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
    expect(stale(queryKeys.boardCard('ws1', 'brd_1', 'crd_1'))).toBe(true)
    expect(stale(queryKeys.boardCard('ws1', 'brd_2', 'crd_2'))).toBe(false)
    expect(workspaceCacheUpdates('ws1', { type: 'set_aside.changed', payload: { botId: 'bot_1' } })).toEqual([
      { kind: 'invalidate', key: queryKeys.setAside('ws1', 'bot_1') },
    ])
    expect(workspaceCacheUpdates('ws1', { type: 'bot.deleted', payload: { botId: 'bot_1' } })).toEqual([])
    expect(workspaceCacheUpdates('ws1', { type: 'vm.status', payload: { vm: {} as never } })).toEqual([
      { kind: 'invalidate', key: queryKeys.vmDetails('ws1') },
      { kind: 'invalidate', key: queryKeys.cliInstall('ws1') },
    ])
  })
})

describe('app cache updates', () => {
  it('refreshes the workspace lists on workspace changes', () => {
    expect(appCacheUpdates({ type: 'workspace.deleted', payload: { workspaceId: 'ws1' } })).toEqual([
      { kind: 'invalidate', key: ['app', 'workspaces'] },
    ])
    expect(appCacheUpdates({ type: 'golden.status', payload: { status: {} as never } })).toEqual([])
  })
})
