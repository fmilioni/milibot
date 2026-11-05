import type { WorkspaceOverview, WorkspaceSummary } from '@milibot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStore } from '@/features/settings/store'
import { useSetupStore } from '@/features/setup/store'
import { useAppStore } from '@/features/workspace/store'

const overviews = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/features/settings/api', () => ({ listWorkspaceOverviews: () => overviews.list() }))
vi.mock('./VmSettings', () => ({
  VmSettings: ({ lead }: { lead: React.ReactNode }) => (
    <div>
      {lead}
      <p>VM settings</p>
    </div>
  ),
}))

import { ComputerSettings } from './ComputerSettings'

const GiB = 1024 ** 3

function show(computer: WorkspaceSummary['computer'], diskUsedBytes: number | null) {
  overviews.list.mockResolvedValue([{ id: 'ws1', diskUsedBytes } as WorkspaceOverview])
  useAppStore.setState({
    workspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'Home', setup: 'done', computer } as WorkspaceSummary],
    vm: null,
  })
  const setComputer = vi.spyOn(useAppStore.getState(), 'setComputer').mockResolvedValue()
  const deleteVmDisk = vi.spyOn(useAppStore.getState(), 'deleteVmDisk').mockResolvedValue(18 * GiB)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ComputerSettings />
    </QueryClientProvider>,
  )
  return { setComputer, deleteVmDisk }
}

beforeEach(() => {
  useSettingsStore.setState({ host: null, loadHost: vi.fn().mockResolvedValue(undefined) })
  useSetupStore.setState({ golden: null, loadGolden: vi.fn().mockResolvedValue(undefined) })
})

afterEach(() => vi.restoreAllMocks())

describe('ComputerSettings', () => {
  it('leaves the VM only after the user confirms', async () => {
    const { setComputer } = show('vm', null)
    expect(screen.getByText('VM settings')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: /No computer/ }))
    expect(setComputer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Shut down and switch/ }))

    await waitFor(() => expect(setComputer).toHaveBeenCalledWith({ kind: 'none' }))
  })

  it('brings back a kept VM at its stored size', async () => {
    const { setComputer } = show('none', 18 * GiB)
    await screen.findByText(/Previous virtual machine disk/)

    fireEvent.click(screen.getByRole('radio', { name: /Virtual machine/ }))
    fireEvent.click(screen.getByRole('button', { name: /Turn on the virtual machine/ }))

    await waitFor(() => expect(setComputer).toHaveBeenCalledWith({ kind: 'vm' }))
  })

  it('deletes the kept disk after the user confirms', async () => {
    const { deleteVmDisk } = show('none', 18 * GiB)

    fireEvent.click(await screen.findByRole('button', { name: /Delete disk/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toMatch(/Frees 18/)
    fireEvent.click(screen.getAllByRole('button', { name: /Delete disk/ }).at(-1) as HTMLElement)

    await waitFor(() => expect(deleteVmDisk).toHaveBeenCalled())
  })

  it('shows no disk card when the workspace never had a VM', async () => {
    show('none', null)

    await waitFor(() => expect(overviews.list).toHaveBeenCalled())
    expect(screen.queryByText(/Previous virtual machine disk/)).toBeNull()
    expect(screen.getByText('Need the virtual machine')).toBeTruthy()
  })
})
