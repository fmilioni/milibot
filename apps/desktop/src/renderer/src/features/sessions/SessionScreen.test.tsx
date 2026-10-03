import type { WorkSessionDetail } from '@milibot/shared'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { SessionScreen } from './SessionScreen'
import { useSessionStore } from './store'

vi.mock('@/api/daemon', () => ({
  api: () => ({ call: () => Promise.reject(new Error('offline')) }),
}))
vi.mock('@/api/use-api-query', () => ({
  useApiQuery: () => ({ data: null, error: null, loading: false, reload: () => undefined }),
}))
vi.mock('@/app/RightPanel', () => ({ RightPanelContent: () => <div data-testid="opened-panel" /> }))
vi.mock('@/features/chat/MessageList', () => ({ MessageList: () => null }))
vi.mock('@/features/chat/Composer', () => ({ Composer: () => <div data-testid="composer" /> }))
vi.mock('./SessionHeader', () => ({ SessionHeader: () => null }))
vi.mock('./PlanPane', () => ({ PlanPane: () => <div data-testid="session-tabs" /> }))
vi.mock('./ChangesPane', () => ({ ChangesPane: () => <div data-testid="session-tabs" /> }))

const observers = vi.hoisted(() => new Set<ResizeObserverCallback>())

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    observers.add(this.callback)
  }
  disconnect() {
    observers.delete(this.callback)
  }
  unobserve() {}
}

const setAvailable = (width: number) =>
  act(() => {
    for (const callback of observers)
      callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)
  })

const detail = {
  id: 's1',
  botId: 'b1',
  title: 'Fix the layout',
  conversationId: 'c1',
  lane: { status: 'running' },
  steps: { done: 0, total: 0 },
  changes: null,
} as unknown as WorkSessionDetail

const aside = () => screen.queryByRole('complementary')
const separator = () => screen.queryByRole('separator')

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  useSessionStore.setState({ details: { s1: detail } })
  useAppStore.setState({
    workspaceId: 'ws1',
    bots: {},
    rightPanel: null,
    screen: {
      kind: 'session',
      sessionId: 's1',
      conversationId: 'c1',
      originConversationId: 'c0',
      botId: 'b1',
      restorePanel: null,
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SessionScreen side panel', () => {
  it('steps aside without room for it and the conversation, keeping the composer', () => {
    localStorage.setItem('milibot.session.panelWidth', '400')
    render(<SessionScreen />)
    setAvailable(1000)
    expect(aside()?.style.width).toBe('400px')
    expect(screen.getAllByTestId('session-tabs')).toHaveLength(1)

    setAvailable(779)
    expect(aside()).toBeNull()
    expect(separator()).toBeNull()
    expect(screen.getByTestId('composer')).not.toBeNull()

    setAvailable(1000)
    expect(aside()?.style.width).toBe('400px')
    expect(separator()).not.toBeNull()
  })

  it('keeps a panel the user opened even without room', () => {
    useAppStore.setState({ rightPanel: 'vm' })
    render(<SessionScreen />)
    setAvailable(340)
    expect(screen.getByTestId('opened-panel')).not.toBeNull()
    expect(screen.getByTestId('composer')).not.toBeNull()
  })

  it('collapses the session panel while the debug panel is open', () => {
    useAppStore.setState({ rightPanel: 'debug' })
    render(<SessionScreen />)
    setAvailable(340)
    expect(aside()).toBeNull()
    expect(screen.getByTestId('composer')).not.toBeNull()
  })
})
