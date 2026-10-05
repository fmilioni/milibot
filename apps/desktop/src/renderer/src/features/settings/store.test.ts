import { DEFAULT_WORKSPACE_PREFERENCES } from '@milibot/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from './store'

const daemon = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/api/daemon', () => ({ api: () => daemon }))

describe('settings store', () => {
  beforeEach(async () => {
    daemon.call.mockResolvedValue({ ...DEFAULT_WORKSPACE_PREFERENCES })
    await useSettingsStore.getState().loadPreferences('ws1')
  })

  it('shows preferences changed elsewhere at once, only for its workspace', () => {
    const changed = { ...DEFAULT_WORKSPACE_PREFERENCES, maxParallelBots: 6, draftPrs: false }
    useSettingsStore.getState().applyEvent('ws2', {
      type: 'preferences.updated',
      payload: { preferences: { ...changed, maxParallelBots: 9 } },
    })
    expect(useSettingsStore.getState().preferences?.maxParallelBots).toBe(3)
    useSettingsStore
      .getState()
      .applyEvent('ws1', { type: 'preferences.updated', payload: { preferences: changed } })
    expect(useSettingsStore.getState().preferences).toMatchObject({ maxParallelBots: 6, draftPrs: false })
  })
})
