import type { LlmCallUsage } from '@milibot/shared'

export interface PriceTable {
  priceInputPerMtokUsd: number | null
  priceCacheReadPerMtokUsd: number | null
  priceCacheWritePerMtokUsd: number | null
  priceOutputPerMtokUsd: number | null
  pricePerRequestUsd: number | null
}

export type TokenUsage = Pick<
  LlmCallUsage,
  'inputTokens' | 'cachedReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens'
>

/**
 * Computes cost from configured prices. Reasoning tokens bill as output; cached reads and writes
 * fall back to the input price when no specific price is configured. Returns null without prices.
 */
export function computeCostUsd(usage: TokenUsage, prices: PriceTable): number | null {
  const input = prices.priceInputPerMtokUsd
  const output = prices.priceOutputPerMtokUsd
  if (input === null && output === null && prices.pricePerRequestUsd === null) return null
  const perToken = (price: number | null) => (price ?? 0) / 1_000_000
  return (
    usage.inputTokens * perToken(input) +
    usage.cachedReadTokens * perToken(prices.priceCacheReadPerMtokUsd ?? input) +
    usage.cacheWriteTokens * perToken(prices.priceCacheWritePerMtokUsd ?? input) +
    (usage.outputTokens + usage.reasoningTokens) * perToken(output) +
    (prices.pricePerRequestUsd ?? 0)
  )
}

export function usageWithCost(
  tokens: TokenUsage,
  providerCost: number | null | undefined,
  prices: PriceTable | null,
): LlmCallUsage {
  if (typeof providerCost === 'number' && Number.isFinite(providerCost)) {
    return { ...tokens, costUsd: providerCost, costSource: 'provider' }
  }
  const computed = prices ? computeCostUsd(tokens, prices) : null
  return computed === null
    ? { ...tokens, costUsd: null, costSource: 'unknown' }
    : { ...tokens, costUsd: computed, costSource: 'computed' }
}

export const EMPTY_TOKENS: TokenUsage = {
  inputTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
}

export const ZERO_USAGE: LlmCallUsage = { ...EMPTY_TOKENS, costUsd: null, costSource: 'unknown' }
