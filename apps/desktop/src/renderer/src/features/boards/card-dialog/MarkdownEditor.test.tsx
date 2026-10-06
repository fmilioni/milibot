import type { Board } from '@milibot/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@/features/workspace/store'

import { MarkdownEditor } from './MarkdownEditor'

const board = { id: 'brd_1', labels: [] } as unknown as Board

function Editor({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return <MarkdownEditor board={board} value={value} onChange={setValue} rows={4} label="Description" />
}

describe('MarkdownEditor', () => {
  beforeEach(() => useAppStore.setState({ workspaceId: 'ws_1' }))

  it('switches Write and Preview as tabs, with the arrow keys too', () => {
    render(<Editor initial="**bold** text" />)
    const write = screen.getByRole('tab', { name: 'Write' })
    const preview = screen.getByRole('tab', { name: 'Preview' })
    expect(write.getAttribute('aria-selected')).toBe('true')
    expect(preview.getAttribute('tabindex')).toBe('-1')
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeTruthy()

    fireEvent.keyDown(write, { key: 'ArrowRight' })
    expect(preview.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(preview)
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(preview.id)

    fireEvent.keyDown(preview, { key: 'ArrowLeft' })
    expect(write.getAttribute('aria-selected')).toBe('true')
  })

  it('formats the selection from the toolbar', () => {
    render(<Editor initial="make it bold" />)
    const field = screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement
    field.setSelectionRange(8, 12)
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }))
    expect(field.value).toBe('make it **bold**')
  })
})
