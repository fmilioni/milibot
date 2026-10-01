import { cliModelInfo, type ReasoningEffort } from '@milibot/shared'

import type { PriceTable } from './usage'

const ALL_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH: ReasoningEffort[] = ['low', 'medium', 'high', 'max']
const LOW_TO_HIGH: ReasoningEffort[] = ['low', 'medium', 'high']

interface AnthropicModelPrice {
  displayName: string
  input: number
  output: number
  cacheRead: number
  contextWindow: number
  maxOutputTokens: number
  /** Values of `output_config.effort` the model accepts ([] = none). */
  efforts: ReasoningEffort[]
  /**
   * `always`: the model thinks unless told otherwise (nothing to send); `opt_in`: it thinks only with
   * `thinking: {type: 'adaptive'}`, sent for efforts above `low` (low = quick side calls without thinking);
   * `none`: no adaptive thinking.
   */
  adaptiveThinking: 'always' | 'opt_in' | 'none'
}

/**
 * Official Anthropic API prices (US$ per 1M tokens). Cache writes (5-minute TTL) bill at 1.25x
 * input. Keys are id prefixes so dated snapshots (`claude-haiku-4-5-20251001`) match too; the
 * longest matching prefix wins. Workspace `provider_models` rows override these.
 */
export const ANTHROPIC_PRICES: Record<string, AnthropicModelPrice> = {
  'claude-fable-5-1': {
    displayName: 'Claude Fable 5.1',
    input: 10,
    output: 50,
    cacheRead: 0.25,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'always',
  },
  'claude-fable-5': {
    displayName: 'Claude Fable 5',
    input: 10,
    output: 50,
    cacheRead: 1,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'always',
  },
  'claude-opus-5-5': {
    displayName: 'Claude Opus 5.5',
    input: 4,
    output: 20,
    cacheRead: 0.2,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'always',
  },
  'claude-opus-5': {
    displayName: 'Claude Opus 5',
    input: 5,
    output: 25,
    cacheRead: 0.5,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'always',
  },
  'claude-opus-4-8': {
    displayName: 'Claude Opus 4.8',
    input: 5,
    output: 25,
    cacheRead: 0.5,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'opt_in',
  },
  'claude-opus-4-7': {
    displayName: 'Claude Opus 4.7',
    input: 5,
    output: 25,
    cacheRead: 0.5,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'opt_in',
  },
  'claude-opus-4-6': {
    displayName: 'Claude Opus 4.6',
    input: 5,
    output: 25,
    cacheRead: 0.5,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: NO_XHIGH,
    adaptiveThinking: 'opt_in',
  },
  'claude-opus-4-5': {
    displayName: 'Claude Opus 4.5',
    input: 5,
    output: 25,
    cacheRead: 0.5,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    efforts: LOW_TO_HIGH,
    adaptiveThinking: 'none',
  },
  'claude-sonnet-5-5': {
    displayName: 'Claude Sonnet 5.5',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'always',
  },
  'claude-sonnet-5': {
    displayName: 'Claude Sonnet 5',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: ALL_EFFORTS,
    adaptiveThinking: 'always',
  },
  'claude-sonnet-4-6': {
    displayName: 'Claude Sonnet 4.6',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    efforts: NO_XHIGH,
    adaptiveThinking: 'opt_in',
  },
  'claude-sonnet-4-5': {
    displayName: 'Claude Sonnet 4.5',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    efforts: [],
    adaptiveThinking: 'none',
  },
  'claude-haiku-4-5': {
    displayName: 'Claude Haiku 4.5',
    input: 1,
    output: 5,
    cacheRead: 0.1,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    efforts: [],
    adaptiveThinking: 'none',
  },
}

const CACHE_WRITE_MULTIPLIER = 1.25

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'

export function anthropicModelInfo(model: string): (AnthropicModelPrice & { id: string }) | null {
  const bare = model.replace(/^anthropic\//, '')
  let best: string | null = null
  for (const prefix of Object.keys(ANTHROPIC_PRICES)) {
    if ((bare === prefix || bare.startsWith(`${prefix}-`)) && (!best || prefix.length > best.length)) {
      best = prefix
    }
  }
  if (!best) return null
  return { id: best, ...(ANTHROPIC_PRICES[best] as AnthropicModelPrice) }
}

export function anthropicPrices(model: string): PriceTable | null {
  const info = anthropicModelInfo(model)
  if (!info) return null
  return {
    priceInputPerMtokUsd: info.input,
    priceOutputPerMtokUsd: info.output,
    priceCacheReadPerMtokUsd: info.cacheRead,
    priceCacheWritePerMtokUsd: info.input * CACHE_WRITE_MULTIPLIER,
    pricePerRequestUsd: null,
  }
}

/** OpenAI price of a Codex model (its catalog in `CODEX_MODELS`); OpenAI bills cache writes as input. */
export function codexPrices(model: string | null): PriceTable | null {
  const info = cliModelInfo('codex', model)
  if (info?.input === undefined || info.output === undefined || info.cacheRead === undefined) return null
  return {
    priceInputPerMtokUsd: info.input,
    priceOutputPerMtokUsd: info.output,
    priceCacheReadPerMtokUsd: info.cacheRead,
    priceCacheWritePerMtokUsd: info.input,
    pricePerRequestUsd: null,
  }
}
