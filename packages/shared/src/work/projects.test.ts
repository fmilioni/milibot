import { describe, expect, it } from 'vitest'

import { inProjectView } from './projects'

describe('inProjectView', () => {
  it('shows general material plus the current project by default', () => {
    const view = { mode: 'default', current: 'prj_a' } as const
    expect(inProjectView(null, view)).toBe(true)
    expect(inProjectView('prj_a', view)).toBe(true)
    expect(inProjectView('prj_b', view)).toBe(false)
    expect(inProjectView('prj_b', { mode: 'default', current: null })).toBe(false)
  })

  it('narrows to one project, to general material, or shows everything', () => {
    expect(inProjectView('prj_a', { mode: 'only', projectId: 'prj_a' })).toBe(true)
    expect(inProjectView(null, { mode: 'only', projectId: 'prj_a' })).toBe(false)
    expect(inProjectView(null, { mode: 'general' })).toBe(true)
    expect(inProjectView('prj_a', { mode: 'general' })).toBe(false)
    expect(inProjectView('prj_b', { mode: 'any' })).toBe(true)
    expect(inProjectView('prj_b', undefined)).toBe(true)
  })
})
