import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LinkifiedText } from './LinkifiedText'
import { StretchedButton } from './StretchedButton'

describe('StretchedButton', () => {
  it('is named by its text and leaves its links outside the button', () => {
    const openExternal = vi.fn(() => Promise.resolve())
    Object.assign(window, { milibot: { openExternal } })
    const onClick = vi.fn()
    render(
      <StretchedButton onClick={onClick}>
        <LinkifiedText text="Plan for https://a.example.com/x" />
      </StretchedButton>,
    )
    const button = screen.getByRole('button', { name: 'Plan for https://a.example.com/x' })
    const link = screen.getByRole('link', { name: 'https://a.example.com/x' })
    expect(button.contains(link)).toBe(false)

    fireEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://a.example.com/x')
    expect(onClick).not.toHaveBeenCalled()

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })
})
