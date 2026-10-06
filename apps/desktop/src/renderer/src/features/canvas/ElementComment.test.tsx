import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ElementCommentPopover } from './ElementCommentPopover'
import { useElementComment } from './use-element-comment'

const pageDoc = vi.hoisted(() => ({ current: null as Document | null }))
vi.mock('./frame-iframes', () => ({ frameDocument: () => pageDoc.current }))

function popover(onSend = vi.fn(() => Promise.resolve()), onClose = vi.fn(), onPick = vi.fn()) {
  const nav = document.createElement('nav')
  const link = document.createElement('a')
  nav.append(link)
  render(
    <ElementCommentPopover
      stage={{ current: null }}
      box={{ x: 10, y: 10, width: 50, height: 20 }}
      trail={[
        { key: nav, label: 'nav' },
        { key: link, label: 'a' },
      ]}
      onPick={onPick}
      onSend={onSend}
      onClose={onClose}
      keepOpen={() => false}
    />,
  )
  const box = screen.getByRole('textbox')
  return { box, nav, onSend, onClose, onPick }
}

describe('ElementCommentPopover', () => {
  it('is a labelled dialog that takes the focus, with Send off while empty', () => {
    const { box } = popover()
    expect(screen.getByRole('dialog', { name: 'Comment on ‹a›' })).toBeTruthy()
    expect(document.activeElement).toBe(box)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends on Enter and keeps typing on Shift+Enter', async () => {
    const { box, onSend } = popover()
    fireEvent.change(box, { target: { value: 'bigger' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    expect(onSend).toHaveBeenCalledWith('bigger')
  })

  it('shows an error and keeps the text when sending fails', async () => {
    const { box } = popover(vi.fn(() => Promise.reject(new Error('offline'))))
    fireEvent.change(box, { target: { value: 'bigger' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    expect(screen.getByRole('alert').textContent).toBe("Couldn't send the comment. Try again.")
    expect((box as HTMLTextAreaElement).value).toBe('bigger')
  })

  it('closes on Escape and Cancel, and picks a parent from the trail', () => {
    const { box, nav, onClose, onPick } = popover()
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'nav' }))
    expect(onPick).toHaveBeenCalledWith(nav)
  })
})

describe('useElementComment', () => {
  const setup = () => {
    const doc = document.implementation.createHTMLDocument('')
    doc.body.innerHTML = '<nav><ul><li><a>Home</a></li></ul></nav>'
    const rect = (sel: string, w: number, h: number) => {
      ;(doc.querySelector(sel) as Element).getBoundingClientRect = () => new DOMRect(0, 0, w, h)
    }
    rect('nav', 400, 60)
    rect('ul', 300, 50)
    rect('li', 200, 40)
    rect('a', 100, 30)
    doc.elementsFromPoint = () => [doc.querySelector('a') as Element, doc.body]
    pageDoc.current = doc
    const frames = [{ id: 'frm_1', designId: 'd', name: 'F', x: 0, y: 0, width: 400, height: 300 }]
    const hook = renderHook(
      ({ tool }) =>
        useElementComment({
          enabled: true,
          tool,
          rects: frames.map((f) => ({ ...f, height: 300 })),
          frames: frames.map((f) => ({ ...f, measuredHeight: null, theme: null, position: 0, updatedAt: 0 })),
          replaced: new Set(),
          worldAt: (e) => ({ x: e.clientX, y: e.clientY }),
        }),
      { initialProps: { tool: true } },
    )
    const click = () =>
      act(() => {
        hook.result.current.onPointerDown(
          {
            button: 0,
            clientX: 5,
            clientY: 5,
            preventDefault: () => undefined,
          } as ReactPointerEvent<HTMLDivElement>,
          false,
        )
      })
    const key = (init: KeyboardEventInit) =>
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', init)))
    const tag = () => hook.result.current.picked?.element.tagName
    return { hook, click, key, tag, doc }
  }

  it('follows the picked element into the page that replaced it', () => {
    const { click, tag, hook, doc } = setup()
    click()
    const next = document.implementation.createHTMLDocument('')
    next.body.innerHTML = '<nav><ul><li><a>Home 2</a></li></ul></nav>'
    ;(next.querySelector('a') as Element).getBoundingClientRect = () => new DOMRect(4, 6, 120, 30)
    pageDoc.current = next
    expect(doc.querySelector('a')?.isConnected).toBe(true)
    act(() => hook.result.current.onFrameLoad('frm_1'))
    expect(tag()).toBe('A')
    expect(hook.result.current.picked?.element.ownerDocument).toBe(next)
    expect(hook.result.current.picked?.element.textContent).toBe('Home 2')
    expect(hook.result.current.picked?.box).toMatchObject({ width: 120, height: 30 })
  })

  it('lets go when the picked element is gone from the new page', () => {
    const { click, hook } = setup()
    click()
    const next = document.implementation.createHTMLDocument('')
    next.body.innerHTML = '<main><p>Other</p></main>'
    pageDoc.current = next
    act(() => hook.result.current.onFrameLoad('frm_1'))
    expect(hook.result.current.picked).toBeNull()
  })

  it('picks the deepest element, goes up with Alt+↑ and back with Alt+↓', () => {
    const { click, key, tag } = setup()
    click()
    expect(tag()).toBe('A')
    key({ key: 'ArrowUp', altKey: true })
    key({ key: 'ArrowUp', altKey: true })
    expect(tag()).toBe('UL')
    key({ key: 'ArrowDown', altKey: true })
    expect(tag()).toBe('LI')
    key({ key: 'ArrowDown', altKey: true })
    expect(tag()).toBe('A')
  })

  it('goes one level down when the picked element is clicked again', () => {
    const { click, key, tag, hook } = setup()
    click()
    key({ key: 'ArrowUp', altKey: true })
    key({ key: 'ArrowUp', altKey: true })
    key({ key: 'ArrowUp', altKey: true })
    expect(tag()).toBe('NAV')
    click()
    expect(tag()).toBe('UL')
    act(() => hook.result.current.pickInTrail(hook.result.current.picked?.element.parentElement as Element))
    expect(tag()).toBe('NAV')
  })

  it('lets go on Escape and never points without the tool or Alt', () => {
    const { click, key, hook } = setup()
    click()
    key({ key: 'Escape' })
    expect(hook.result.current.picked).toBeNull()
    hook.rerender({ tool: false })
    expect(hook.result.current.active).toBe(false)
    key({ key: 'Alt' })
    expect(hook.result.current.active).toBe(true)
    act(() => void window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' })))
    expect(hook.result.current.active).toBe(false)
  })
})
