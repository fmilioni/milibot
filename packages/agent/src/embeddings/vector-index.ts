import { quantizeInt8 } from './vector'

export interface VectorSearchHit<Id> {
  id: Id
  /** ≈ cosine similarity (vectors are unit length). */
  score: number
}

/**
 * In-memory index of one vector space. The daemon keeps one per space, filled from
 * `knowledge_vectors` (`addQuantized`), and updates it as chunks are embedded or deleted.
 */
interface VectorIndex<Id = string> {
  readonly dimensions: number
  readonly size: number
  has(id: Id): boolean
  /** Adds or replaces; `vector` must be unit length and `dimensions` long. */
  add(id: Id, vector: ArrayLike<number>): void
  /** Adds or replaces an already quantized vector (as stored in SQLite). */
  addQuantized(id: Id, data: Int8Array, scale: number): void
  remove(id: Id): boolean
  clear(): void
  /** Best `topK` by dot product, highest first; `filter` skips ids (e.g. docs outside the bot's scope). */
  search(query: ArrayLike<number>, topK: number, filter?: (id: Id) => boolean): VectorSearchHit<Id>[]
  /** Approximate heap used by the vectors. */
  memoryBytes(): number
}

/**
 * Brute force over a contiguous int8 matrix (1 byte per dimension + 4 bytes of scale per vector):
 * 100k × 768 dims ≈ 77 MB.
 */
export class Int8VectorIndex<Id = string> implements VectorIndex<Id> {
  private data: Int8Array
  private scales: Float32Array
  private ids: Id[] = []
  private readonly slots = new Map<Id, number>()

  constructor(
    readonly dimensions: number,
    initialCapacity = 1024,
  ) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error(`invalid dimensions ${dimensions}`)
    const capacity = Math.max(1, initialCapacity)
    this.data = new Int8Array(capacity * dimensions)
    this.scales = new Float32Array(capacity)
  }

  get size(): number {
    return this.ids.length
  }

  has(id: Id): boolean {
    return this.slots.has(id)
  }

  add(id: Id, vector: ArrayLike<number>): void {
    const q = quantizeInt8(vector)
    this.addQuantized(id, q.data, q.scale)
  }

  addQuantized(id: Id, data: Int8Array, scale: number): void {
    if (data.length !== this.dimensions) {
      throw new Error(`vector has ${data.length} dimensions, index has ${this.dimensions}`)
    }
    let slot = this.slots.get(id)
    if (slot === undefined) {
      slot = this.ids.length
      this.ensureCapacity(slot + 1)
      this.ids.push(id)
      this.slots.set(id, slot)
    }
    this.data.set(data, slot * this.dimensions)
    this.scales[slot] = scale
  }

  remove(id: Id): boolean {
    const slot = this.slots.get(id)
    if (slot === undefined) return false
    const last = this.ids.length - 1
    if (slot !== last) {
      const lastId = this.ids[last]!
      this.data.copyWithin(slot * this.dimensions, last * this.dimensions, (last + 1) * this.dimensions)
      this.scales[slot] = this.scales[last]!
      this.ids[slot] = lastId
      this.slots.set(lastId, slot)
    }
    this.ids.pop()
    this.slots.delete(id)
    return true
  }

  clear(): void {
    this.ids = []
    this.slots.clear()
  }

  memoryBytes(): number {
    return this.data.byteLength + this.scales.byteLength
  }

  search(query: ArrayLike<number>, topK: number, filter?: (id: Id) => boolean): VectorSearchHit<Id>[] {
    if (query.length !== this.dimensions) {
      throw new Error(`query has ${query.length} dimensions, index has ${this.dimensions}`)
    }
    if (topK <= 0 || this.ids.length === 0) return []
    const q = Float32Array.from(query)
    const dims = this.dimensions
    const data = this.data
    const heap = new TopK<Id>(topK)
    for (let slot = 0; slot < this.ids.length; slot++) {
      const id = this.ids[slot]!
      if (filter && !filter(id)) continue
      const base = slot * dims
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let s3 = 0
      let j = 0
      for (; j + 3 < dims; j += 4) {
        s0 += q[j]! * data[base + j]!
        s1 += q[j + 1]! * data[base + j + 1]!
        s2 += q[j + 2]! * data[base + j + 2]!
        s3 += q[j + 3]! * data[base + j + 3]!
      }
      for (; j < dims; j++) s0 += q[j]! * data[base + j]!
      heap.push(id, (s0 + s1 + s2 + s3) * this.scales[slot]!)
    }
    return heap.sorted()
  }

  private ensureCapacity(count: number): void {
    const capacity = this.scales.length
    if (count <= capacity) return
    const next = Math.max(count, Math.ceil(capacity * 1.5))
    const data = new Int8Array(next * this.dimensions)
    data.set(this.data.subarray(0, this.ids.length * this.dimensions))
    const scales = new Float32Array(next)
    scales.set(this.scales.subarray(0, this.ids.length))
    this.data = data
    this.scales = scales
  }
}

/** Min-heap of the best `k` scores seen. */
class TopK<Id> {
  private readonly scores: number[] = []
  private readonly items: Id[] = []

  constructor(private readonly k: number) {}

  push(id: Id, score: number): void {
    if (this.scores.length < this.k) {
      this.scores.push(score)
      this.items.push(id)
      this.up(this.scores.length - 1)
    } else if (score > this.scores[0]!) {
      this.scores[0] = score
      this.items[0] = id
      this.down(0)
    }
  }

  sorted(): VectorSearchHit<Id>[] {
    return this.items.map((id, i) => ({ id, score: this.scores[i]! })).sort((a, b) => b.score - a.score)
  }

  private swap(a: number, b: number): void {
    ;[this.scores[a], this.scores[b]] = [this.scores[b]!, this.scores[a]!]
    ;[this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!]
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.scores[parent]! <= this.scores[i]!) return
      this.swap(i, parent)
      i = parent
    }
  }

  private down(i: number): void {
    const n = this.scores.length
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let min = i
      if (l < n && this.scores[l]! < this.scores[min]!) min = l
      if (r < n && this.scores[r]! < this.scores[min]!) min = r
      if (min === i) return
      this.swap(i, min)
      i = min
    }
  }
}
