import { estimateTokens } from '@milibot/shared'

import type { EmbeddingKind, EmbeddingProvider, EmbeddingResult } from './types'
import { EmbeddingError } from './types'
import { normalize } from './vector'

export interface FakeEmbeddingOptions {
  dimensions?: number
  maxInputTokens?: number
  key?: string
  /** Simulated latency per call. */
  delayMs?: number
  /** Adds `costUsd` to the usage, like an API provider. */
  pricePerMtokUsd?: number
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function fakeEmbeddingTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)
}

/**
 * Deterministic embeddings for tests: a signed hashed bag of words (accents and case ignored), so
 * texts sharing words are close and the same text always gives the same vector. No model, no I/O.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly key: string
  readonly dimensions: number
  readonly maxInputTokens: number
  readonly calls: Array<{ texts: string[]; kind: EmbeddingKind }> = []
  disposed = false

  constructor(private readonly options: FakeEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 64
    this.maxInputTokens = options.maxInputTokens ?? 512
    this.key = options.key ?? `fake:hash:${this.dimensions}`
  }

  vector(text: string): Float32Array {
    const v = new Float32Array(this.dimensions)
    const tokens = fakeEmbeddingTokens(text)
    if (tokens.length === 0) {
      v[0] = 1
      return v
    }
    for (const token of tokens) {
      const h = fnv1a(token)
      v[h % this.dimensions]! += h & 0x80000000 ? -1 : 1
    }
    return normalize(v)
  }

  async embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<EmbeddingResult> {
    this.calls.push({ texts: [...texts], kind })
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs))
    if (signal?.aborted) throw new EmbeddingError('aborted', 'embedding aborted')
    const tokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0)
    return {
      vectors: texts.map((t) => this.vector(t)),
      usage: {
        tokens,
        ...(this.options.pricePerMtokUsd !== undefined
          ? { costUsd: (tokens * this.options.pricePerMtokUsd) / 1e6 }
          : {}),
      },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}
