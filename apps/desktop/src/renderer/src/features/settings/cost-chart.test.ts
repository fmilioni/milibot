import { describe, expect, it } from 'vitest'

import { costBars } from './cost-chart'

describe('costBars', () => {
  it('scales bars to the most expensive day and marks today', () => {
    const bars = costBars([
      { day: '2026-09-24', costUsd: 2, tokens: 10 },
      { day: '2026-09-25', costUsd: 0, tokens: 0 },
      { day: '2026-09-26', costUsd: 4, tokens: 20 },
    ])
    expect(bars.map((b) => [b.heightPct, b.today])).toEqual([
      [50, false],
      [0, false],
      [100, true],
    ])
  })

  it('keeps an idle period flat', () => {
    expect(costBars([{ day: '2026-09-26', costUsd: 0, tokens: 0 }])[0]?.heightPct).toBe(0)
  })
})
