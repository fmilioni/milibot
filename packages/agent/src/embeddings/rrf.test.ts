import { describe, expect, it } from 'vitest'

import { lexicalQueryWeight, reciprocalRankFusion } from './rrf'

describe('reciprocalRankFusion', () => {
  it('scores Σ weight / (k + rank) and ranks items found by both lists first', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'a', 'd'],
    ])
    expect(fused.map((r) => r.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 12)
    expect(fused[0]!.ranks).toEqual([1, 2])
    expect(fused.find((r) => r.id === 'd')!.ranks).toEqual([null, 3])
  })

  it('applies weights, k and limit', () => {
    const lists = [{ ids: ['x', 'y'], weight: 0 }, { ids: ['y', 'x'] }]
    expect(reciprocalRankFusion(lists).map((r) => r.id)).toEqual(['y', 'x'])
    expect(reciprocalRankFusion([['a']], { k: 0 })[0]!.score).toBe(1)
    expect(reciprocalRankFusion([['a', 'b', 'c']], { limit: 2 })).toHaveLength(2)
  })

  it('with a zero weight the other list only fills after the ranked items', () => {
    const fused = reciprocalRankFusion([{ ids: ['z', 'a'], weight: 0 }, { ids: ['a', 'b'] }])
    expect(fused.map((r) => r.id)).toEqual(['a', 'b', 'z'])
  })

  it('counts duplicates within a list once and breaks ties by first appearance', () => {
    const fused = reciprocalRankFusion([
      ['a', 'a', 'b'],
      ['b', 'a'],
    ])
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 12)
    expect(fused.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('lexicalQueryWeight', () => {
  it('gives full weight to identifier-like queries', () => {
    for (const q of [
      'E04',
      'CC-310',
      'HTTP 429 Retry-After',
      'Lei 13.709/2018',
      'secret/data/api/prod',
      'getUserById',
      'MAX_RETRIES',
      '"price adjustment clause"',
    ]) {
      expect(lexicalQueryWeight(q), q).toBe(1)
    }
  })

  it('leaves prose, amounts and small numbers to the vectors', () => {
    for (const q of [
      'How is the contract price adjusted every year?',
      'Who approves a purchase of $5,000?',
      'The supplier sent the invoice on day 28',
      'What do I need to run the API locally?',
      'kubectl rollout undo',
    ]) {
      expect(lexicalQueryWeight(q), q).toBe(0)
    }
  })
})
