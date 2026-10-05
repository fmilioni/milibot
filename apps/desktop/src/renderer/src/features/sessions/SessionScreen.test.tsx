import type { WorkSessionDetail } from '@milibot/shared'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Ref } from 'react'
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
vi.mock('./SessionHeader', () => ({
  SessionHeader: ({
    panelToggle,
    panelToggleRef,
  }: {
    panelToggle?: { open: boolean; onToggle: () => void }
    panelToggleRef?: Ref<HTMLButtonElement>
  }) => (
    <header>
      {panelToggle && (
        <button
          type="button"
          ref={panelToggleRef}
          aria-expanded={panelToggle.open}
          onClick={panelToggle.onToggle}
        >
          toggle
        </button>
      )}
    </header>
  ),
}))
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
const toggle = () => screen.queryByRole('button', { name: 'toggle' })
const dialog = () => screen.queryByRole('dialog')
const openOverlay = (available: number) => {
  render(<SessionScreen />)
  setAvailable(available)
  fireEvent.click(toggle() as HTMLElement)
  return dialog() as HTMLElement
}
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

describe('SessionScreen collapsed panel overlay', () => {
  it('shows the toggle only while the panel is collapsed', () => {
    render(<SessionScreen />)
    setAvailable(1000)
    expect(toggle()).toBeNull()
    setAvailable(779)
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens over the conversation with focus on the selected tab, keeping the composer', () => {
    const overlay = openOverlay(680)
    expect(overlay.getAttribute('aria-modal')).toBe('true')
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
    expect(overlay.contains(document.activeElement)).toBe(true)
    expect(screen.getByTestId('composer')).not.toBeNull()
    expect(aside()).toBeNull()
  })

  it('closes on Escape and gives the focus back to the toggle', () => {
    const overlay = openOverlay(680)
    fireEvent.keyDown(overlay, { key: 'Escape' })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('leaves Escape to a child that handled it', () => {
    const overlay = openOverlay(680)
    const tab = document.activeElement as HTMLElement
    tab.addEventListener('keydown', (event) => event.preventDefault())
    fireEvent.keyDown(tab, { key: 'Escape' })
    expect(dialog()).toBe(overlay)
  })

  it('closes with its close button, the toggle and a click outside, but not a click in the header', () => {
    openOverlay(680)
    fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }))
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(toggle())

    fireEvent.click(toggle() as HTMLElement)
    fireEvent.click(toggle() as HTMLElement)
    expect(dialog()).toBeNull()

    fireEvent.click(toggle() as HTMLElement)
    fireEvent.pointerDown(screen.getByRole('banner'))
    expect(dialog()).not.toBeNull()
    expect(fireEvent.pointerDown(screen.getByTestId('composer'))).toBe(false)
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(toggle())
  })

  it('keeps Tab inside', () => {
    const overlay = openOverlay(680)
    const close = screen.getByRole('button', { name: 'Close (Esc)' })
    const first = screen.getAllByRole('tab')[0] as HTMLElement
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)
    expect(overlay.contains(document.activeElement)).toBe(true)
  })

  it('is 400px wide, leaves a strip of conversation, or takes the whole column', () => {
    const overlay = openOverlay(680)
    expect(overlay.style.width).toBe('400px')
    setAvailable(420)
    expect(overlay.style.width).toBe('364px')
    expect(document.querySelector('.bg-scrim-panel')).not.toBeNull()
    setAvailable(320)
    expect(overlay.style.width).toBe('')
    expect(document.querySelector('.bg-scrim-panel')).toBeNull()
  })

  it('closes when the room comes back, docking the panel again', () => {
    openOverlay(680)
    setAvailable(1000)
    expect(dialog()).toBeNull()
    expect(aside()).not.toBeNull()
    setAvailable(680)
    expect(dialog()).toBeNull()
  })

  it('closes when the user opens another panel', () => {
    openOverlay(680)
    act(() => useAppStore.setState({ rightPanel: 'vm' }))
    expect(dialog()).toBeNull()
    expect(screen.getByTestId('opened-panel')).not.toBeNull()
  })
})
