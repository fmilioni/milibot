import { describe, expect, it } from 'vitest'

import { type AutoStartCandidate, selectAutoStart } from '../../src/supervisor/autostart'

const base: AutoStartCandidate = {
  id: 'ws',
  setup: 'done',
  closeBehavior: 'suspend_vm',
  lastRunning: true,
  enabledRoutines: 0,
}

describe('selectAutoStart', () => {
  it('starts workspaces that were running and keep their VM running', () => {
    expect(selectAutoStart([{ ...base, closeBehavior: 'keep_running' }])).toEqual(['ws'])
  })

  it('starts workspaces with enabled routines whatever the close behavior', () => {
    expect(selectAutoStart([{ ...base, enabledRoutines: 2 }])).toEqual(['ws'])
  })

  it('leaves a suspended workspace without routines alone', () => {
    expect(selectAutoStart([base])).toEqual([])
  })

  it('never starts a workspace that was not running in the previous session', () => {
    expect(
      selectAutoStart([{ ...base, lastRunning: false, closeBehavior: 'keep_running', enabledRoutines: 3 }]),
    ).toEqual([])
  })

  it('skips workspaces still in the setup', () => {
    for (const setup of ['providers', 'vm', 'login'] as const) {
      expect(
        selectAutoStart([{ ...base, setup, closeBehavior: 'keep_running', enabledRoutines: 1 }]),
      ).toEqual([])
    }
  })

  it('keeps the input order', () => {
    expect(
      selectAutoStart([
        { ...base, id: 'a', closeBehavior: 'keep_running' },
        { ...base, id: 'b' },
        { ...base, id: 'c', enabledRoutines: 1 },
      ]),
    ).toEqual(['a', 'c'])
  })
})
