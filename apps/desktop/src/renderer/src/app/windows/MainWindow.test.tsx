import type { WorkspaceSummary } from '@milibot/shared'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

const { marker } = vi.hoisted(() => ({
  marker: (name: string) => () => <div data-testid={name} />,
}))
vi.mock('@/features/sidebar/Sidebar', () => ({ Sidebar: marker('sidebar') }))
vi.mock('@/features/chat/ChatPanel', () => ({ ChatPanel: marker('chat') }))
vi.mock('@/features/settings/SettingsScreen', () => ({ SettingsScreen: marker('settings') }))
vi.mock('@/features/canvas/CanvasScreen', () => ({ CanvasScreen: marker('canvas') }))
vi.mock('@/features/boards/BoardsScreen', () => ({ BoardsScreen: marker('boards') }))
vi.mock('@/features/designs/DesignsScreen', () => ({ DesignsScreen: marker('designs') }))
vi.mock('@/features/files/FilesScreen', () => ({ FilesScreen: marker('files') }))
vi.mock('@/features/sessions/SessionScreen', () => ({ SessionScreen: marker('session') }))
vi.mock('@/features/setup/SetupScreen', () => ({ SetupScreen: marker('setup') }))
vi.mock('@/app/RightPanel', () => ({ RightPanel: marker('right-panel') }))
vi.mock('@/app/ModalHost', () => ({ ModalHost: () => null }))
vi.mock('@/app/ReconnectingBanner', () => ({ ReconnectingBanner: () => null }))
vi.mock('@/app/Toaster', () => ({ Toaster: () => null }))

import { MainWindow } from './MainWindow'

const workspace = (setup: WorkspaceSummary['setup']) =>
  ({ id: 'ws1', name: 'Home', setup }) as WorkspaceSummary

const shown = () =>
  [
    'setup',
    'sidebar',
    'chat',
    'settings',
    'canvas',
    'boards',
    'designs',
    'files',
    'session',
    'right-panel',
  ].filter((name) => screen.queryByTestId(name))

beforeEach(() => {
  useAppStore.setState({
    phase: 'ready',
    boot: async () => {},
    workspaceId: 'ws1',
    workspaces: [workspace('done')],
    screen: { kind: 'chat' },
    rightPanel: 'vm',
  })
})

describe('MainWindow', () => {
  it('renders the screen the navigation points at', () => {
    render(<MainWindow />)
    expect(shown()).toEqual(['sidebar', 'chat', 'right-panel'])
    act(() => useAppStore.getState().openSettings('providers'))
    expect(shown()).toEqual(['settings'])
    act(() => useAppStore.getState().openBoards())
    expect(shown()).toEqual(['sidebar', 'boards'])
    act(() => useAppStore.getState().navigate({ kind: 'canvas', designId: 'dsg_1', sidebar: false }))
    expect(shown()).toEqual(['canvas'])
    act(() => useAppStore.getState().openFiles())
    expect(shown()).toEqual(['sidebar', 'files'])
  })

  it('shows the session with the debug panel only, and the chat again when it closes', () => {
    render(<MainWindow />)
    const session = {
      kind: 'session',
      sessionId: 's',
      conversationId: 'c',
      originConversationId: 'o',
      botId: 'b',
    } as const
    act(() => useAppStore.getState().navigate(session))
    expect(shown()).toEqual(['sidebar', 'session'])
    act(() => useAppStore.getState().toggleRightPanel('debug'))
    expect(shown()).toEqual(['sidebar', 'session', 'right-panel'])
    act(() => useAppStore.getState().closeWorkSession())
    expect(shown()).toEqual(['sidebar', 'chat', 'right-panel'])
    expect(useAppStore.getState().rightPanel).toBe('vm')
  })

  it('shows the setup until the workspace is set up, whatever the navigation', () => {
    useAppStore.setState({ workspaces: [workspace('providers')], screen: { kind: 'files' } })
    render(<MainWindow />)
    expect(shown()).toEqual(['setup'])
  })
})
