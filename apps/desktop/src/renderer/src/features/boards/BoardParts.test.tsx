import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BoardProgressBar } from './BoardParts'

const counts = { todo: 1, doing: 1, done: 2, dropped: 0 }

describe('BoardProgressBar', () => {
  it('uses the surface track by default', () => {
    const { container } = render(<BoardProgressBar counts={counts} />)
    expect(container.firstElementChild?.className).toMatch(/\bbg-surface-3\b/)
  })

  it('swaps the track when one is given', () => {
    const { container } = render(<BoardProgressBar counts={counts} track="bg-fg/15" />)
    const bar = container.firstElementChild?.className ?? ''
    expect(bar).toContain('bg-fg/15')
    expect(bar).not.toMatch(/\bbg-surface-3\b/)
  })
})
