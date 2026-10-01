import { describe, expect, it } from 'vitest'

import { createWorkspaceScope } from './workspace-scope'

function scoped() {
  let state = { workspaceId: null as string | null, items: [] as string[] }
  const get = () => state
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch }
  }
  return { get, scope: createWorkspaceScope(get, set, () => ({ items: [] })) }
}

describe('createWorkspaceScope', () => {
  it('resets the data when the workspace changes, not when it stays', () => {
    const { get, scope } = scoped()
    scope.forWorkspace('ws1')
    scope.commit('ws1', { items: ['a'] })
    scope.forWorkspace('ws1')
    expect(get()).toEqual({ workspaceId: 'ws1', items: ['a'] })
    scope.forWorkspace('ws2')
    expect(get()).toEqual({ workspaceId: 'ws2', items: [] })
  })

  it('drops answers for a workspace the store no longer holds', () => {
    const { get, scope } = scoped()
    scope.forWorkspace('ws2')
    expect(scope.commit('ws1', { items: ['late'] })).toBe(false)
    expect(scope.commit('ws2', () => ({ items: ['now'] }))).toBe(true)
    expect(get().items).toEqual(['now'])
    expect(scope.isCurrent('ws2')).toBe(true)
  })
})
