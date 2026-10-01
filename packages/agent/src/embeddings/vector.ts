/** Every stored vector is unit length, so cosine similarity = dot product. */

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!
  return sum
}

export function norm(v: ArrayLike<number>): number {
  return Math.sqrt(dot(v, v))
}

/** Unit-length copy (a zero vector stays zero). */
export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v)
  const n = norm(out)
  if (n > 0) for (let i = 0; i < out.length; i++) out[i]! /= n
  return out
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = norm(a) * norm(b)
  return d > 0 ? dot(a, b) / d : 0
}

/**
 * Matryoshka (MRL) truncation: keeps the first `dimensions` values and renormalizes. Only valid for
 * models trained for it (EmbeddingGemma: 768/512/256/128).
 */
export function truncateMrl(v: ArrayLike<number>, dimensions: number): Float32Array {
  if (dimensions > v.length) throw new Error(`cannot truncate a ${v.length}-d vector to ${dimensions}`)
  const head = new Float32Array(dimensions)
  for (let i = 0; i < dimensions; i++) head[i] = v[i]!
  return normalize(head)
}

/**
 * Symmetric int8 quantization: `value ≈ data[i] * scale`, with `scale = max|v| / 127`. For unit
 * vectors the cosine error is ~1e-3, well below what changes a ranking.
 */
export interface QuantizedVector {
  data: Int8Array
  scale: number
}

export function quantizeInt8(v: ArrayLike<number>): QuantizedVector {
  let max = 0
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]!))
  const scale = max > 0 ? max / 127 : 1
  const data = new Int8Array(v.length)
  for (let i = 0; i < v.length; i++) data[i] = Math.max(-127, Math.min(127, Math.round(v[i]! / scale)))
  return { data, scale }
}

export function dequantizeInt8(q: QuantizedVector): Float32Array {
  const out = new Float32Array(q.data.length)
  for (let i = 0; i < out.length; i++) out[i] = q.data[i]! * q.scale
  return out
}

/** Dot product of a float query with a quantized vector (≈ cosine when both are unit length). */
export function dotInt8(query: ArrayLike<number>, q: QuantizedVector): number {
  let sum = 0
  const n = Math.min(query.length, q.data.length)
  for (let i = 0; i < n; i++) sum += query[i]! * q.data[i]!
  return sum * q.scale
}

/** Bytes for a SQLite BLOB column (the scale goes in its own column). */
export function int8ToBlob(data: Int8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/** Reads a BLOB written by `int8ToBlob` (copies, so the result does not alias SQLite's buffer). */
export function blobToInt8(blob: Uint8Array): Int8Array {
  const out = new Int8Array(blob.byteLength)
  out.set(new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength))
  return out
}
