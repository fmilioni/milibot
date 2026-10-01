import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THRESHOLDS,
  textMinTerms,
  thresholdsForSpace,
} from '../../../src/runtime/embeddings/thresholds'

describe('knowledge thresholds', () => {
  it('uses the values measured for each local model and dimension', () => {
    expect(thresholdsForSpace('local:embeddinggemma-300m:q4:768')).toMatchObject({
      suggestMinScore: 0.35,
      chunkMinScore: 0.4,
      mergeMinRatio: 0.85,
    })
    expect(thresholdsForSpace('local:embeddinggemma-300m:q4:256').suggestMinScore).toBe(0.42)
    const e5 = thresholdsForSpace('local:multilingual-e5-small:q8:384')
    expect(e5.suggestMinScore).toBeGreaterThan(0.8)
    expect(e5.mergeMinRatio).toBe(0.97)
  })

  it('falls back to the defaults for API models, fake embeddings and no index', () => {
    expect(thresholdsForSpace('api:prov_1:qwen/qwen3-embedding-8b:4096')).toEqual(DEFAULT_THRESHOLDS)
    expect(thresholdsForSpace('fake:hash:64')).toEqual(DEFAULT_THRESHOLDS)
    expect(thresholdsForSpace('local:unknown-model:q8:512')).toEqual(DEFAULT_THRESHOLDS)
    expect(thresholdsForSpace(null)).toEqual(DEFAULT_THRESHOLDS)
  })

  it('asks more of text-only matches for prose when vectors are available', () => {
    expect(textMinTerms(DEFAULT_THRESHOLDS, 'what is the contract penalty?', true)).toBe(3)
    expect(textMinTerms(DEFAULT_THRESHOLDS, 'what is the contract penalty?', false)).toBe(2)
    expect(textMinTerms(DEFAULT_THRESHOLDS, 'error E04 on the coffee maker', true)).toBe(2)
  })
})
