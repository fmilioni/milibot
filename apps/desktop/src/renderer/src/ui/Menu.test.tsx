import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Menu, type MenuEntry } from './Menu'

function setup() {
  const onClose = vi.fn()
  const selected = vi.fn()
  const entries: MenuEntry[] = [
    { key: 'rename', label: 'Rename', onSelect: () => selected('rename') },
    { key: 'archive', label: 'Archive', disabled: true, onSelect: () => selected('archive') },
    { type: 'separator', key: 'sep' },
    {
      key: 'move',
      label: 'Move to',
      submenu: [
        { key: 'top', label: 'Top', onSelect: () => selected('top') },
        { key: 'bottom', label: 'Bottom', onSelect: () => selected('bottom') },
      ],
    },
    { key: 'delete', label: 'Delete', danger: true, onSelect: () => selected('delete') },
  ]
  render(<Menu entries={entries} x={40} y={60} label="Actions" onClose={onClose} />)
  const menu = screen.getByRole('menu', { name: 'Actions' })
  return { menu, onClose, selected }
}

describe('Menu', () => {
  it('is positioned at the point, focused and visible', () => {
    const { menu } = setup()
    expect(document.activeElement).toBe(menu)
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('60px')
    expect(menu.style.visibility).not.toBe('hidden')
  })

  it('moves past disabled items and picks with Enter', () => {
    const { menu, onClose, selected } = setup()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(selected).toHaveBeenCalledWith('delete')
    expect(onClose).toHaveBeenCalled()
  })

  it('wraps around with ArrowUp', () => {
    const { menu, selected } = setup()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: ' ' })
    expect(selected).toHaveBeenCalledWith('delete')
  })

  it('opens a submenu with ArrowRight and goes back with ArrowLeft', () => {
    const { menu, selected } = setup()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowRight' })
    const move = screen.getByRole('menuitem', { name: 'Move to' })
    expect(move.getAttribute('aria-expanded')).toBe('true')
    const submenu = screen.getAllByRole('menu')[1] as HTMLElement
    fireEvent.keyDown(submenu, { key: 'ArrowDown' })
    fireEvent.keyDown(submenu, { key: 'ArrowDown' })
    fireEvent.keyDown(submenu, { key: 'Enter' })
    expect(selected).toHaveBeenCalledWith('bottom')
  })

  it('closes a submenu with ArrowLeft, keeping the root open', () => {
    const { menu, onClose } = setup()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'ArrowRight' })
    const submenu = screen.getAllByRole('menu')[1] as HTMLElement
    fireEvent.keyDown(submenu, { key: 'ArrowLeft' })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and on a pointer down outside, not inside', () => {
    const { menu, onClose } = setup()
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
