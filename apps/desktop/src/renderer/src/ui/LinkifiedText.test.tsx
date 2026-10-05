import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LinkifiedText } from './LinkifiedText'

describe('LinkifiedText', () => {
  it('renders the URLs as links and keeps the rest as text', () => {
    const { container } = render(
      <p>
        <LinkifiedText text="Merge https://github.com/org/repo/pull/18? Yes." />
      </p>,
    )
    const link = screen.getByRole('link', { name: 'https://github.com/org/repo/pull/18' })
    expect(link.getAttribute('href')).toBe('https://github.com/org/repo/pull/18')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer')
    expect(container.querySelector('p')?.textContent).toBe('Merge https://github.com/org/repo/pull/18? Yes.')
    expect(container.querySelector('p > span')).toBeNull()
  })

  it('opens the link in the system browser without letting the click through', () => {
    const openExternal = vi.fn(() => Promise.resolve())
    Object.assign(window, { milibot: { openExternal } })
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <LinkifiedText text="see https://a.example.com/x" />
      </div>,
    )
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    fireEvent(screen.getByRole('link'), event)
    expect(openExternal).toHaveBeenCalledWith('https://a.example.com/x')
    expect(event.defaultPrevented).toBe(true)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('renders text without links as is', () => {
    const { container } = render(<LinkifiedText text="nothing here" />)
    expect(container.innerHTML).toBe('nothing here')
  })
})
