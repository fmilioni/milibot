import { describe, expect, it } from 'vitest'

import { lazy } from '../../../src/runtime/composition/lazy'
import { Lifecycle } from '../../../src/runtime/composition/lifecycle'

describe('lifecycle', () => {
  it('starts in order and stops in reverse, going on past a failing stop', async () => {
    const calls: string[] = []
    const failures: string[] = []
    const lifecycle = new Lifecycle((name) => failures.push(name)).add(
      { name: 'a', start: () => void calls.push('start a'), stop: () => void calls.push('stop a') },
      {
        name: 'b',
        start: async () => void calls.push('start b'),
        stop: () => {
          throw new Error('b')
        },
      },
      { name: 'c', stop: () => void calls.push('stop c') },
    )
    await lifecycle.start()
    await lifecycle.stop()
    expect(calls).toEqual(['start a', 'start b', 'stop c', 'stop a'])
    expect(failures).toEqual(['b'])
  })

  it('stops what already started when a start fails', async () => {
    const calls: string[] = []
    const lifecycle = new Lifecycle().add(
      { name: 'a', stop: () => void calls.push('stop a') },
      {
        name: 'b',
        start: () => {
          throw new Error('no')
        },
        stop: () => void calls.push('stop b'),
      },
    )
    await expect(lifecycle.start()).rejects.toThrow('no')
    expect(calls).toEqual(['stop a'])
  })

  it('reads a lazy reference only once it is set', () => {
    const ref = lazy<number>('answer')
    expect(() => ref.get()).toThrow('answer is used before the runtime built it')
    ref.set(42)
    expect(ref.get()).toBe(42)
    expect(() => ref.set(1)).toThrow('answer was already set')
  })
})
