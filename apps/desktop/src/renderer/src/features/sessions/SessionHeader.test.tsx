import type { WorkSessionDetail } from '@milibot/shared'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { SessionHeader } from './SessionHeader'

vi.mock('@/api/daemon', () => ({
  api: () => ({ call: () => Promise.reject(new Error('offline')) }),
}))
vi.mock('@/features/providers/use-model-catalog', () => ({
  useModelCatalog: () => [],
  findCatalogModel: () => null,
}))

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

const setHeaderWidth = (width: number) =>
  act(() => {
    for (const callback of observers)
      callback(
        [
          { target: screen.getByRole('heading'), contentRect: { width: 40 } },
          { target: screen.getByRole('banner'), contentRect: { width } },
        ] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      )
  })

const detail = (files: number) =>
  ({
    id: 's1',
    botId: 'b1',
    title: 'Fix the layout',
    status: 'running',
    conversationId: 'c1',
    originConversationId: 'c0',
    lane: { status: 'idle' },
    steps: { done: 3, total: 7 },
    changes: files > 0 ? { files, additions: 1, deletions: 1 } : null,
    costUsd: 0,
    branch: null,
    cwd: null,
    projectId: null,
    model: null,
  }) as unknown as WorkSessionDetail

const toggle = { open: false, controls: 'overlay', onToggle: () => undefined }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  useAppStore.setState({ workspaceId: 'ws1', rightPanel: null, conversations: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SessionHeader plan and changes toggle', () => {
  it('shows only while the panel is collapsed', () => {
    render(<SessionHeader session={detail(0)} bot={undefined} bots={{}} />)
    expect(screen.queryByRole('button', { name: 'Plan and changes' })).toBeNull()
  })

  it('counts the changed files, capped at 99+', () => {
    const { rerender } = render(
      <SessionHeader session={detail(0)} bot={undefined} bots={{}} panelToggle={toggle} />,
    )
    const button = screen.getByRole('button', { name: 'Plan and changes' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.hasAttribute('aria-pressed')).toBe(false)
    expect(button.textContent).toBe('')

    rerender(<SessionHeader session={detail(12)} bot={undefined} bots={{}} panelToggle={toggle} />)
    expect(screen.getByRole('button', { name: 'Plan and changes, 12 files changed' }).textContent).toBe('12')

    rerender(<SessionHeader session={detail(140)} bot={undefined} bots={{}} panelToggle={toggle} />)
    expect(screen.getByRole('button', { name: 'Plan and changes, 140 files changed' }).textContent).toBe(
      '99+',
    )
  })

  it('points at the overlay while it is open', () => {
    const onToggle = vi.fn()
    render(
      <SessionHeader
        session={detail(2)}
        bot={undefined}
        bots={{}}
        panelToggle={{ open: true, controls: 'overlay', onToggle }}
      />,
    )
    const button = screen.getByRole('button', { name: 'Plan and changes, 2 files changed' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe('overlay')
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('moves the VM screen into the options menu in a narrow header', () => {
    render(<SessionHeader session={detail(0)} bot={undefined} bots={{}} panelToggle={toggle} />)
    setHeaderWidth(400)
    expect(screen.queryByRole('button', { name: 'VM screen' })).not.toBeNull()
    setHeaderWidth(300)
    expect(screen.queryByRole('button', { name: 'VM screen' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Session options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'VM screen' }))
    expect(useAppStore.getState().rightPanel).toBe('vm')
  })
})
