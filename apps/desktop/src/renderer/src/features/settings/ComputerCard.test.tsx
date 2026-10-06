import { DEFAULT_APP_SETTINGS } from '@milibot/shared'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { ComputerCard } from './ComputerCard'

const KEEP_AWAKE = 'Keep the computer from sleeping while bots work'

function setup(loginItem: boolean | null, platform = 'linux') {
  Object.assign(window, {
    milibot: { platform, getLoginItem: vi.fn(() => Promise.resolve(loginItem)), setLoginItem: vi.fn() },
  })
  useAppStore.setState({ appSettings: DEFAULT_APP_SETTINGS })
  const update = vi.spyOn(useAppStore.getState(), 'updateAppSettings').mockResolvedValue()
  render(<ComputerCard />)
  return { update }
}

describe('ComputerCard', () => {
  afterEach(() => vi.restoreAllMocks())

  it('turns keeping the computer awake on and off, on by default', () => {
    const { update } = setup(true)
    const toggle = screen.getByRole('switch', { name: KEEP_AWAKE })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ keepAwake: false })
  })

  it('still offers the option where the platform has no login item', async () => {
    setup(null)
    await waitFor(() => expect(window.milibot.getLoginItem).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('switch', { name: /log in/ })).toBeNull())
    expect(screen.getByRole('switch', { name: KEEP_AWAKE })).toBeTruthy()
  })

  it('says what the system does at shutdown on each platform', () => {
    setup(true, 'darwin')
    expect(screen.getByText(/Shutting down while bots work asks you first/)).toBeTruthy()
  })
})
