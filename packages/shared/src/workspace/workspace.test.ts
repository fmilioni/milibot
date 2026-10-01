import { describe, expect, it } from 'vitest'

import { VmLifecycleState } from '../vm/vm'
import { byRecentlyOpened } from './workspace'

describe('workspaces', () => {
  it('sorts workspaces by last opened, then creation', () => {
    const list = [
      { id: 'a', createdAt: 1, lastOpenedAt: null },
      { id: 'b', createdAt: 2, lastOpenedAt: 10 },
      { id: 'c', createdAt: 5, lastOpenedAt: null },
    ]
    expect([...list].sort(byRecentlyOpened).map((w) => w.id)).toEqual(['b', 'c', 'a'])
  })

  it('keeps the VM lifecycle states of VmInfo without `suspended`', () => {
    expect(VmLifecycleState.options).toEqual([
      'not_created',
      'stopped',
      'starting',
      'running',
      'stopping',
      'error',
    ])
  })
})
