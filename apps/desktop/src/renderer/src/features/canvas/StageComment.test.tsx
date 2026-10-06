import type { DesignDetail } from '@milibot/shared'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { Stage } from './Stage'

const pageDoc = vi.hoisted(() => ({ current: null as Document | null }))
vi.mock('./frame-iframes', () => ({
  frameDocument: () => pageDoc.current,
  registerFrameIframe: () => () => undefined,
}))
vi.mock('./FramePage', () => ({ FramePage: () => null }))

const design = {
  id: 'dsg_1',
  name: 'Onboarding',
  conversationId: 'cnv_1',
  botId: null,
  themes: ['light'],
  tokens: [],
  fonts: [],
  frameCount: 1,
  thumbnailSha: null,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  frames: [
    {
      id: 'frm_1',
      designId: 'dsg_1',
      name: 'Home',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      measuredHeight: null,
      theme: null,
      position: 0,
      updatedAt: 0,
    },
  ],
} satisfies DesignDetail

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

function stage(commentTool: boolean) {
  const doc = document.implementation.createHTMLDocument('')
  doc.body.innerHTML = '<nav><a>Home</a></nav>'
  for (const el of doc.body.querySelectorAll('*')) el.getBoundingClientRect = () => new DOMRect(0, 0, 100, 30)
  doc.elementsFromPoint = () => [doc.querySelector('a') as Element, doc.body]
  pageDoc.current = doc
  const onComment = vi.fn(() => Promise.resolve())
  const onSelect = vi.fn()
  render(
    <Stage
      workspaceId="ws_1"
      design={design}
      bots={{}}
      viewport={{ x: 0, y: 0, zoom: 1 }}
      onViewport={vi.fn()}
      size={{ width: 800, height: 600 }}
      onSize={vi.fn()}
      forcedTheme={null}
      overrides={{}}
      selectedId={null}
      onSelect={onSelect}
      onFrameMenu={vi.fn()}
      onZoomToFrame={vi.fn()}
      onFit={vi.fn()}
      presence={null}
      commentTool={commentTool}
      onComment={onComment}
    />,
  )
  const canvas = screen.getByRole('application')
  fireEvent.pointerDown(canvas, { button: 0, altKey: !commentTool, clientX: 5, clientY: 5 })
  // A real click on the box: pointer down where the frame is (the box floats above it), mouse down, click.
  const press = (el: Element) => {
    fireEvent.pointerDown(el, { button: 0, clientX: 5, clientY: 5 })
    if (fireEvent.mouseDown(el, { button: 0 })) (el as HTMLElement).focus()
    fireEvent.click(el)
  }
  return { press, onComment, onSelect, doc }
}

describe('the comment box on the canvas', () => {
  it('sends with a click on Send', async () => {
    const { press, onComment, onSelect, doc } = stage(false)
    const box = screen.getByRole('textbox')
    press(box)
    expect(document.activeElement).toBe(box)
    fireEvent.change(box, { target: { value: 'bigger' } })
    await act(async () => press(screen.getByRole('button', { name: 'Send' })))
    expect(onComment).toHaveBeenCalledWith('frm_1', doc.querySelector('a'), 'bigger')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('picks the parent clicked in the trail, with the Comment tool on', () => {
    stage(true)
    expect(screen.getByRole('dialog', { name: 'Comment on ‹a›' })).toBeTruthy()
    {
      const nav = screen.getByRole('button', { name: 'nav' })
      // Off the frame: the box sits beside the element.
      fireEvent.pointerDown(nav, { button: 0, clientX: 500, clientY: 5 })
      fireEvent.click(nav)
    }
    expect(screen.getByRole('dialog', { name: 'Comment on ‹nav›' })).toBeTruthy()
  })
})
