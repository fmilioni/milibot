import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Modal } from './Modal'

function renderModal(onClose = vi.fn()) {
  render(
    <>
      <button type="button">outside</button>
      <Modal title="Rename" width={400} onClose={onClose} footer={<button type="button">Save</button>}>
        <input aria-label="Name" />
      </Modal>
    </>,
  )
  return onClose
}

describe('Modal', () => {
  it('focuses the first control and keeps Tab inside the dialog', () => {
    renderModal()
    const close = screen.getByRole('button', { name: 'Close' })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(document.activeElement).toBe(close)
    save.focus()
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
  })

  it('closes on Escape unless a child already handled it', () => {
    const onClose = renderModal()
    const input = screen.getByRole('textbox', { name: 'Name' })
    input.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to a floating layer opened over it', () => {
    const onClose = renderModal()
    const layer = document.createElement('div')
    layer.dataset.menu = ''
    document.body.append(layer)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    layer.remove()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the backdrop is pressed, not the dialog', () => {
    const onClose = renderModal()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
