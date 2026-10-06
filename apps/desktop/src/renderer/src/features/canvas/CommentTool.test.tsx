import type { DesignDetail } from '@milibot/shared'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CanvasToolbar } from './CanvasToolbar'
import { useCanvasShortcuts } from './use-canvas-shortcuts'

const design = {
  id: 'dsg_1',
  name: 'Onboarding',
  conversationId: 'cnv_1',
  botId: null,
  themes: ['light'],
  tokens: [],
  fonts: [],
  frameCount: 0,
  thumbnailSha: null,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  frames: [],
} satisfies DesignDetail

function toolbar(commentTool: boolean, canComment: boolean, onCommentTool = vi.fn()) {
  render(
    <CanvasToolbar
      workspaceId="ws_1"
      design={design}
      bot={undefined}
      windowMode={false}
      canSwitch={false}
      forcedTheme={null}
      variablesOpen={false}
      exportOpen={false}
      exporting={false}
      commentTool={commentTool}
      canComment={canComment}
      onCommentTool={onCommentTool}
      onSwitcher={vi.fn()}
      onThemeMenu={vi.fn()}
      onVariables={vi.fn()}
      onExport={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return { button: screen.getByRole('button', { name: 'Comment' }), onCommentTool }
}

describe('the Comment tool', () => {
  it('is a toggle in the toolbar', () => {
    const { button, onCommentTool } = toolbar(true, true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(onCommentTool).toHaveBeenCalledOnce()
  })

  it('does nothing without a conversation to send to', () => {
    const { button, onCommentTool } = toolbar(false, false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(onCommentTool).not.toHaveBeenCalled()
  })

  it('turns on with C and off with Escape, never while typing', () => {
    const toggleComment = vi.fn()
    const leaveTool = vi.fn()
    renderHook(() =>
      useCanvasShortcuts({
        viewport: { x: 0, y: 0, zoom: 1 },
        size: { width: 800, height: 600 },
        setViewport: vi.fn(),
        fit: vi.fn(),
        copySelected: null,
        deselect: null,
        toggleComment,
        leaveTool,
      }),
    )
    fireEvent.keyDown(window, { key: 'c' })
    expect(toggleComment).toHaveBeenCalledOnce()
    const input = document.createElement('textarea')
    document.body.append(input)
    fireEvent.keyDown(input, { key: 'c' })
    expect(toggleComment).toHaveBeenCalledOnce()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(leaveTool).toHaveBeenCalledOnce()
    input.remove()
  })
})
