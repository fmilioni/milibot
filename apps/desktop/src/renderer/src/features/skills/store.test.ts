import { beforeEach, describe, expect, it, vi } from 'vitest'

const daemon = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/api/daemon', () => ({ api: () => daemon, followWorkspaceEvents: vi.fn() }))

import { useAppStore } from '@/features/workspace/store'

import { useSkillsStore } from './store'

describe('skills store', () => {
  beforeEach(() => {
    daemon.call.mockReset()
    daemon.call.mockResolvedValue([])
    useSkillsStore.setState({ workspaceId: null, detailId: null, skills: [], loaded: false })
    useAppStore.setState({ workspaceId: 'ws1' })
  })

  it('keeps the skill opened from elsewhere when the Skills screen loads for the first time', async () => {
    useSkillsStore.getState().openSkill('skl_1')
    expect(useAppStore.getState().screen).toEqual({ kind: 'settings', section: 'skills' })
    await useSkillsStore.getState().load('ws1')
    expect(useSkillsStore.getState()).toMatchObject({ workspaceId: 'ws1', detailId: 'skl_1' })
  })
})
