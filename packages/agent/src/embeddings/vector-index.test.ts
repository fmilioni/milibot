import { describe, expect, it } from 'vitest'

import { dot, normalize, quantizeInt8 } from './vector'
import { Int8VectorIndex } from './vector-index'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const unit = (values: number[]) => normalize(values)

describe('Int8VectorIndex', () => {
  it('finds the nearest vectors, best first', () => {
    const index = new Int8VectorIndex<string>(3)
    index.add('x', unit([1, 0, 0]))
    index.add('y', unit([0, 1, 0]))
    index.add('xy', unit([1, 1, 0]))
    const hits = index.search(unit([1, 0.1, 0]), 2)
    expect(hits.map((h) => h.id)).toEqual(['x', 'xy'])
    expect(hits[0]!.score).toBeCloseTo(0.995, 2)
    expect(index.size).toBe(3)
  })

  it('replaces, removes (moving the last slot) and filters', () => {
    const index = new Int8VectorIndex<string>(2, 1)
    index.add('a', unit([1, 0]))
    index.add('b', unit([0, 1]))
    index.add('c', unit([-1, 0]))
    index.add('a', unit([0, -1]))
    expect(index.size).toBe(3)
    expect(index.search(unit([0, -1]), 1)[0]!.id).toBe('a')

    expect(index.remove('a')).toBe(true)
    expect(index.remove('a')).toBe(false)
    expect(index.has('a')).toBe(false)
    expect(index.search(unit([-1, 0]), 1)[0]!.id).toBe('c')
    expect(index.search(unit([0, 1]), 5, (id) => id !== 'b').map((h) => h.id)).toEqual(['c'])

    index.clear()
    expect(index.size).toBe(0)
    expect(index.search(unit([1, 0]), 3)).toEqual([])
  })

  it('accepts quantized vectors as stored in SQLite', () => {
    const index = new Int8VectorIndex<number>(2)
    const q = quantizeInt8(unit([0.6, 0.8]))
    index.addQuantized(7, q.data, q.scale)
    expect(index.search(unit([0.6, 0.8]), 1)[0]).toEqual({ id: 7, score: expect.closeTo(1, 2) })
  })

  it('rejects vectors of another size', () => {
    const index = new Int8VectorIndex(4)
    expect(() => index.add('a', [1, 0])).toThrow(/dimensions/)
    expect(() => index.search([1, 0], 1)).toThrow(/dimensions/)
    expect(() => new Int8VectorIndex(0)).toThrow()
  })

  it('matches exact brute force on random data while growing past its capacity', () => {
    const rand = seeded(7)
    const dims = 96
    const index = new Int8VectorIndex<number>(dims, 8)
    const vectors: Float32Array[] = []
    for (let i = 0; i < 2000; i++) {
      const v = normalize(Array.from({ length: dims }, () => rand() - 0.5))
      vectors.push(v)
      index.add(i, v)
    }
    for (let i = 0; i < 1000; i += 3) index.remove(i)
    const alive = vectors.map((v, i) => ({ v, i })).filter(({ i }) => i >= 1000 || i % 3 !== 0)
    expect(index.size).toBe(alive.length)

    for (let t = 0; t < 10; t++) {
      const query = normalize(Array.from({ length: dims }, () => rand() - 0.5))
      const exact = alive
        .map(({ v, i }) => ({ id: i, score: dot(query, v) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
      const hits = index.search(query, 10)
      expect(hits).toHaveLength(10)
      // int8 may swap near-ties; the sets must match and the scores stay close.
      const overlap = hits.filter((h) => exact.some((e) => e.id === h.id)).length
      expect(overlap).toBeGreaterThanOrEqual(9)
      hits.forEach((h, k) => expect(h.score).toBeCloseTo(exact[k]!.score, 1))
      for (let k = 1; k < hits.length; k++) expect(hits[k - 1]!.score).toBeGreaterThanOrEqual(hits[k]!.score)
    }
    expect(index.memoryBytes()).toBeGreaterThanOrEqual(index.size * (dims + 4))
  })
})
