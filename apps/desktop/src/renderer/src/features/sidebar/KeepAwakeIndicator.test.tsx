import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import type { KeepAwakeState } from '../../../../bridge/contract'
import { KeepAwakeIndicator } from './KeepAwakeIndicator'

function bridge(first: KeepAwakeState) {
  let listener: ((state: KeepAwakeState) => void) | null = null
  const off = vi.fn()
  Object.assign(window, {
    milibot: {
      getKeepAwake: vi.fn(() => Promise.resolve(first)),
      onKeepAwakeChanged: (next: (state: KeepAwakeState) => void) => {
        listener = next
        return off
      },
    },
  })
  return { push: (state: KeepAwakeState) => act(() => listener?.(state)), off }
}

describe('KeepAwakeIndicator', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows only while the computer is kept awake and follows the changes', async () => {
    const main = bridge({ active: true, busyBots: 2 })
    const view = render(<KeepAwakeIndicator />)
    const button = await screen.findByRole('button', { name: 'Keeping the computer awake: 2 bots working' })
    expect(button).toBeTruthy()
    main.push({ active: true, busyBots: 1 })
    expect(screen.getByRole('button', { name: 'Keeping the computer awake: 1 bot working' })).toBeTruthy()
    main.push({ active: false, busyBots: 1 })
    expect(screen.queryByRole('button')).toBeNull()
    view.unmount()
    expect(main.off).toHaveBeenCalled()
  })

  it('stays hidden while the lock is off', async () => {
    bridge({ active: false, busyBots: 3 })
    render(<KeepAwakeIndicator />)
    await waitFor(() => expect(window.milibot.getKeepAwake).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the general settings, where the option lives', async () => {
    bridge({ active: true, busyBots: 1 })
    const openSettings = vi.spyOn(useAppStore.getState(), 'openSettings').mockImplementation(() => {})
    render(<KeepAwakeIndicator />)
    fireEvent.click(await screen.findByRole('button'))
    expect(openSettings).toHaveBeenCalledWith('general')
  })
})
