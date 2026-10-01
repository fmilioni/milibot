import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Select } from './Select'

const OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium', disabled: true },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

function Harness({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState('low')
  return (
    <Select
      label="Effort"
      value={value}
      options={OPTIONS}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

function setup() {
  const onChange = vi.fn()
  render(<Harness onChange={onChange} />)
  const trigger = screen.getByRole('combobox', { name: 'Effort' })
  const activeLabel = () => {
    const id = trigger.getAttribute('aria-activedescendant')
    return id ? document.getElementById(id)?.textContent : null
  }
  return { trigger, onChange, activeLabel }
}

describe('Select', () => {
  it('opens on the selected option and moves past disabled ones', () => {
    const { trigger, activeLabel } = setup()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox', { name: 'Effort' })).toBeTruthy()
    expect(activeLabel()).toBe('Low')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(activeLabel()).toBe('High')
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(activeLabel()).toBe('Max')
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(activeLabel()).toBe('Low')
  })

  it('picks the active option with Enter and closes', () => {
    const { trigger, onChange } = setup()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('high')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.textContent).toContain('High')
  })

  it('closes on Escape without changing, and jumps by typing', () => {
    const { trigger, onChange, activeLabel } = setup()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(trigger, { key: 'm' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(activeLabel()).toBe('Max')
  })
})
