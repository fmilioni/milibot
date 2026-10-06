import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import type { AppUpdateState, KeepAwakeState } from '../../../../bridge/contract'
import { AppUpdateCard } from './AppUpdateCard'
import { SidebarFooter } from './SidebarFooter'

function bridge(first: AppUpdateState, options: { busyBots?: number; installs?: boolean } = {}) {
  let listener: ((state: AppUpdateState) => void) | null = null
  const off = vi.fn()
  const keepAwake: KeepAwakeState = { active: false, busyBots: options.busyBots ?? 0 }
  const milibot = {
    getAppUpdate: vi.fn(() => Promise.resolve(first)),
    onAppUpdateChanged: (next: (state: AppUpdateState) => void) => {
      listener = next
      return off
    },
    installAppUpdate: vi.fn(() => Promise.resolve(options.installs ?? true)),
    getKeepAwake: vi.fn(() => Promise.resolve(keepAwake)),
    onKeepAwakeChanged: () => () => undefined,
  }
  Object.assign(window, { milibot })
  return { milibot, off, push: (state: AppUpdateState) => act(() => listener?.(state)) }
}

const ready: AppUpdateState = { status: 'ready', version: '0.5.0' }
const restart = { name: /Restart to update to v0\.5\.0/ }

describe('AppUpdateCard', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('shows only once the update is downloaded', async () => {
    const main = bridge({ status: 'idle' })
    const view = render(<AppUpdateCard />)
    await waitFor(() => expect(main.milibot.getAppUpdate).toHaveBeenCalled())
    for (const state of [
      { status: 'checking' },
      { status: 'downloading', version: '0.5.0', percent: 40 },
      { status: 'error', message: 'offline' },
    ] satisfies AppUpdateState[]) {
      main.push(state)
      expect(screen.queryByText('Update ready')).toBeNull()
    }
    main.push(ready)
    expect(screen.getByText('Update ready')).toBeTruthy()
    expect(screen.getByRole('button', restart)).toBeTruthy()
    view.unmount()
    expect(main.off).toHaveBeenCalled()
  })

  it('restarts right away when no bot is working', async () => {
    const main = bridge(ready)
    render(<AppUpdateCard />)
    fireEvent.click(await screen.findByRole('button', restart))
    await waitFor(() => expect(main.milibot.installAppUpdate).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks first while bots are working', async () => {
    const main = bridge(ready, { busyBots: 2 })
    render(<AppUpdateCard />)
    fireEvent.click(await screen.findByRole('button', restart))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('2 bots are working. Updating now interrupts what they are doing.')
    expect(main.milibot.installAppUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(main.milibot.installAppUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', restart))
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }))
    await waitFor(() => expect(main.milibot.installAppUpdate).toHaveBeenCalledTimes(1))
  })

  it('shows the restart while it installs, with nothing to click', async () => {
    const main = bridge(ready)
    render(<AppUpdateCard />)
    await screen.findByRole('button', restart)
    main.push({ status: 'installing', version: '0.5.0' })
    const button = screen.getByRole('button', { name: /Restarting…/ })
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('warns when the update could not start', async () => {
    bridge(ready, { installs: false })
    const showToast = vi.spyOn(useAppStore.getState(), 'showToast').mockImplementation(() => {})
    render(<AppUpdateCard />)
    fireEvent.click(await screen.findByRole('button', restart))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('error'))
  })

  it('stays dismissed for that version and comes back for the next one', async () => {
    const main = bridge(ready)
    const first = render(<AppUpdateCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Update ready')).toBeNull()
    first.unmount()

    render(<AppUpdateCard />)
    await waitFor(() => expect(main.milibot.getAppUpdate).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Update ready')).toBeNull()
    main.push({ status: 'ready', version: '0.5.1' })
    expect(screen.getByRole('button', { name: /Restart to update to v0\.5\.1/ })).toBeTruthy()
  })

  it('sits right above the cost and tokens line of the sidebar', async () => {
    bridge(ready)
    render(<SidebarFooter />)
    const card = await screen.findByRole('button', restart)
    const usage = screen.getByText(/today/)
    expect(card.compareDocumentPosition(usage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
