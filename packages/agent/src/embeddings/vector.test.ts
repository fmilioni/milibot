import { describe, expect, it } from 'vitest'

import {
  blobToInt8,
  cosine,
  dequantizeInt8,
  dot,
  dotInt8,
  int8ToBlob,
  norm,
  normalize,
  quantizeInt8,
  truncateMrl,
} from './vector'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomUnit(dims: number, rand: () => number): Float32Array {
  // Sum of uniforms ≈ Gaussian, so directions are spread like real embeddings.
  return normalize(Array.from({ length: dims }, () => rand() + rand() + rand() - 1.5))
}

describe('vector utils', () => {
  it('normalizes to unit length and keeps zero vectors zero', () => {
    expect(norm(normalize([3, 4]))).toBeCloseTo(1, 6)
    expect(Array.from(normalize([3, 4]))).toEqual([expect.closeTo(0.6, 6), expect.closeTo(0.8, 6)])
    expect(Array.from(normalize([0, 0, 0]))).toEqual([0, 0, 0])
  })

  it('computes cosine for unnormalized vectors', () => {
    expect(cosine([1, 0], [5, 0])).toBeCloseTo(1, 6)
    expect(cosine([1, 0], [0, 2])).toBeCloseTo(0, 6)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  it('truncates Matryoshka style: first dimensions, renormalized', () => {
    const v = normalize([1, 2, 3, 4, 5, 6])
    const t = truncateMrl(v, 3)
    expect(t).toHaveLength(3)
    expect(norm(t)).toBeCloseTo(1, 6)
    expect(cosine(t, [1, 2, 3])).toBeCloseTo(1, 6)
    expect(() => truncateMrl(v, 7)).toThrow()
  })

  it('quantizes to int8 with a per-vector scale', () => {
    const q = quantizeInt8([0.5, -1, 0.25, 0])
    expect(Array.from(q.data)).toEqual([64, -127, 32, 0])
    expect(q.scale).toBeCloseTo(1 / 127, 9)
    expect(Array.from(dequantizeInt8(q))).toEqual([
      expect.closeTo(0.5, 2),
      expect.closeTo(-1, 6),
      expect.closeTo(0.25, 2),
      0,
    ])
    expect(quantizeInt8([0, 0]).scale).toBe(1)
  })

  it('keeps cosine similarity within 0.01 and preserves rankings on 768-d vectors', () => {
    const rand = seeded(42)
    const docs = Array.from({ length: 200 }, () => randomUnit(768, rand))
    const quantized = docs.map((d) => quantizeInt8(d))
    let maxError = 0
    let sameTop = 0
    for (let i = 0; i < 20; i++) {
      // Queries near a document, like a question and its answer.
      const target = docs[i * 7]!
      const query = normalize(target.map((x) => x + (rand() - 0.5) * 0.08))
      const exact = docs.map((d) => dot(query, d))
      const approx = quantized.map((q) => dotInt8(query, q))
      exact.forEach((e, j) => (maxError = Math.max(maxError, Math.abs(e - approx[j]!))))
      const best = (scores: number[]) => scores.indexOf(Math.max(...scores))
      if (best(exact) === best(approx)) sameTop++
    }
    expect(maxError).toBeLessThan(0.01)
    expect(sameTop).toBe(20)
  })

  it('round-trips int8 through a BLOB without aliasing', () => {
    const data = Int8Array.from([-127, -1, 0, 1, 127])
    const blob = int8ToBlob(data)
    expect(blob.byteLength).toBe(5)
    const back = blobToInt8(new Uint8Array(blob))
    expect(Array.from(back)).toEqual([-127, -1, 0, 1, 127])
    blob[0] = 0
    expect(back[0]).toBe(-127)
  })
})
