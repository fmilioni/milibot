import type { GoldenStatus, VmInfo, VmTask } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  availableSystemRevision,
  dismissSystemUpdate,
  goldenWait,
  isSystemUpdateDismissed,
  newRevisions,
  systemUpdatePhase,
  vmTaskBusy,
} from './system-update'

const vm = (system?: VmInfo['system']): VmInfo => ({
  state: 'running',
  config: { cpus: 4, memGb: 8, dataGb: 60, systemGb: 40 },
  portBase: 47000,
  desktops: 1,
  ...(system ? { system } : {}),
})

const golden = (patch: Partial<GoldenStatus>): GoldenStatus => ({
  state: 'ready',
  stage: null,
  percent: 0,
  downloadBytes: null,
  etaSeconds: null,
  startedAt: null,
  error: null,
  revision: 1,
  latestRevision: 2,
  outdated: true,
  ...patch,
})

describe('system update', () => {
  it('offers the newest revision only to an older system', () => {
    expect(availableSystemRevision(null)).toBeNull()
    expect(availableSystemRevision(vm())).toBeNull()
    expect(availableSystemRevision(vm({ goldenVersion: '1', revision: 2, latestRevision: 2 }))).toBeNull()
    expect(availableSystemRevision(vm({ goldenVersion: '1', revision: 1, latestRevision: 3 }))).toBe(3)
    expect(newRevisions(vm({ goldenVersion: '1', revision: 1, latestRevision: 3 }))).toEqual([2, 3])
    expect(newRevisions(vm())).toEqual([])
  })

  it('tells a waiting or running update from a finished one, apart from the task that holds the VM', () => {
    const task = (kind: VmTask['kind'], status: VmTask['status']): VmTask => ({
      kind,
      status,
      error: null,
      startedAt: 1,
      finishedAt: null,
    })
    const waiting = { status: 'waiting_task' as const, whenIdle: true, requestedAt: 1 }
    expect(systemUpdatePhase({ task: task('snapshot_create', 'running'), systemUpdate: waiting })).toBe(
      'waiting_task',
    )
    expect(systemUpdatePhase({ task: task('update_system', 'running'), systemUpdate: null })).toBe('running')
    expect(systemUpdatePhase({ task: task('update_system', 'done'), systemUpdate: null })).toBeNull()
    expect(systemUpdatePhase({ task: task('restart', 'running'), systemUpdate: null })).toBeNull()
    expect(systemUpdatePhase({ task: null, systemUpdate: null })).toBeNull()

    expect(vmTaskBusy(task('grow_disk', 'running'))).toBe(true)
    expect(vmTaskBusy(task('restart', 'waiting_idle'))).toBe(true)
    expect(vmTaskBusy(task('update_system', 'done'))).toBe(false)
    expect(vmTaskBusy(null)).toBe(false)
  })

  it('describes the golden image the update waits for', () => {
    expect(goldenWait(golden({ state: 'building', percent: 40, etaSeconds: 300 }))).toEqual({
      state: 'building',
      percent: 40,
      etaSeconds: 300,
    })
    expect(goldenWait(golden({ error: 'build exited with code 1' }))).toEqual({
      state: 'failed',
      error: 'build exited with code 1',
    })
    expect(goldenWait(golden({ state: 'failed', revision: null, outdated: false, error: 'x' })).state).toBe(
      'failed',
    )
    expect(goldenWait(golden({ outdated: false, revision: 2 })).state).toBe('pending')
    expect(goldenWait(null).state).toBe('pending')
  })

  it('remembers a dismissed card per workspace and revision, surviving blocked storage', () => {
    const values = new Map<string, string>()
    const store = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
    }
    dismissSystemUpdate('ws_a', 2, store)
    expect(isSystemUpdateDismissed('ws_a', 2, store)).toBe(true)
    expect(isSystemUpdateDismissed('ws_a', 3, store)).toBe(false)
    expect(isSystemUpdateDismissed('ws_b', 2, store)).toBe(false)

    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => dismissSystemUpdate('ws_a', 2, blocked)).not.toThrow()
    expect(isSystemUpdateDismissed('ws_a', 2, blocked)).toBe(false)
    expect(isSystemUpdateDismissed('ws_a', 2, null)).toBe(false)
  })
})
