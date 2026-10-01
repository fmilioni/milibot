import { describe, expect, it } from 'vitest'

import { EmbedQueue, type QueuedEmbedding } from './embed-queue'

const job = (client: string, kind: 'query' | 'document', ...texts: string[]): QueuedEmbedding => ({
  client,
  kind,
  texts,
})

const names = (jobs: QueuedEmbedding[]) => jobs.map((j) => j.texts.join('+'))

describe('EmbedQueue', () => {
  it('runs waiting queries first, merged, then document batches round-robin across clients', () => {
    const queue = new EmbedQueue()
    for (const j of [
      job('A', 'document', 'a1'),
      job('A', 'document', 'a2'),
      job('A', 'document', 'a3'),
      job('B', 'document', 'b1'),
      job('B', 'query', 'qb'),
      job('C', 'document', 'c1'),
      job('A', 'query', 'qa'),
    ])
      queue.push(j)
    expect(queue.size).toBe(7)
    const runs: string[][] = []
    for (let run = queue.next(32); run.length > 0; run = queue.next(32)) runs.push(names(run))
    expect(runs).toEqual([['qb', 'qa'], ['a1'], ['b1'], ['c1'], ['a2'], ['a3']])
    expect(queue.size).toBe(0)
  })

  it('caps a merged query run by texts, but always takes one query', () => {
    const queue = new EmbedQueue()
    queue.push(job('A', 'query', 'x', 'y', 'z'))
    queue.push(job('B', 'query', 'q'))
    expect(names(queue.next(2))).toEqual(['x+y+z'])
    expect(names(queue.next(2))).toEqual(['q'])
  })

  it('removes a waiting job and drains everything', () => {
    const queue = new EmbedQueue()
    const a = job('A', 'document', 'a')
    const q = job('A', 'query', 'q')
    queue.push(a)
    queue.push(q)
    queue.push(job('B', 'document', 'b'))
    expect(queue.remove(a)).toBe(true)
    expect(queue.remove(a)).toBe(false)
    expect(queue.remove(q)).toBe(true)
    expect(names(queue.drain())).toEqual(['b'])
    expect(queue.next(32)).toEqual([])
  })
})
