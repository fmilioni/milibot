import { describe, expect, it } from 'vitest'

import { currentComputerHas, workspaceHas } from './computer'

describe('workspaceHas', () => {
  it('gives a VM workspace every capability', () => {
    expect(workspaceHas({ computer: 'vm' }, 'shell')).toBe(true)
    expect(workspaceHas({ computer: 'vm' }, 'desktop')).toBe(true)
  })

  it('gives a workspace without a computer none', () => {
    expect(workspaceHas({ computer: 'none' }, 'shell')).toBe(false)
    expect(workspaceHas({ computer: 'none' }, 'browser')).toBe(false)
  })
})

describe('currentComputerHas', () => {
  it("reads the window's workspace", () => {
    const workspaces = [{ id: 'ws_1', computer: 'none' as const }]

    expect(currentComputerHas({ workspaces, workspaceId: 'ws_1' }, 'desktop')).toBe(false)
  })

  it('assumes a computer until the workspace is known', () => {
    expect(currentComputerHas({ workspaces: [], workspaceId: null }, 'desktop')).toBe(true)
  })
})
