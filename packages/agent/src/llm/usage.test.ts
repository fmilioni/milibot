import { describe, expect, it } from 'vitest'

import { computeCostUsd } from './usage'

const usage = {
  inputTokens: 1_000_000,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
}
const noPrices = {
  priceInputPerMtokUsd: null,
  priceCacheReadPerMtokUsd: null,
  priceCacheWritePerMtokUsd: null,
  priceOutputPerMtokUsd: null,
  pricePerRequestUsd: null,
}

describe('computeCostUsd', () => {
  it('returns null without prices', () => {
    expect(computeCostUsd(usage, noPrices)).toBeNull()
  })

  it('bills reasoning as output and falls back to input price for cache', () => {
    const cost = computeCostUsd(
      {
        inputTokens: 1_000_000,
        cachedReadTokens: 1_000_000,
        cacheWriteTokens: 0,
        outputTokens: 500_000,
        reasoningTokens: 500_000,
      },
      { ...noPrices, priceInputPerMtokUsd: 3, priceOutputPerMtokUsd: 15, pricePerRequestUsd: 0.01 },
    )
    expect(cost).toBeCloseTo(3 + 3 + 15 + 0.01)
  })

  it('uses specific cache prices when configured', () => {
    const cost = computeCostUsd(
      { ...usage, inputTokens: 0, cachedReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      {
        ...noPrices,
        priceInputPerMtokUsd: 3,
        priceCacheReadPerMtokUsd: 0.3,
        priceCacheWritePerMtokUsd: 3.75,
      },
    )
    expect(cost).toBeCloseTo(4.05)
  })
})
