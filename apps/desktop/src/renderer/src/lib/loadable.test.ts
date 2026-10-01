import { describe, expect, it } from 'vitest'

import { type Loadable, loadEntry, patchLoadable } from './loadable'

describe('patchLoadable', () => {
  it('starts a missing entry empty and keeps the others', () => {
    const other: Loadable<number> = { data: 1, loading: false, error: false }
    expect(patchLoadable({ other }, 'key', { loading: true })).toEqual({
      other,
      key: { data: null, loading: true, error: false },
    })
  })
})

describe('loadEntry', () => {
  const store = () => {
    let entries: Record<string, Loadable<string>> = { a: { data: 'old', loading: false, error: true } }
    return {
      read: () => entries,
      write: (next: Record<string, Loadable<string>>) => {
        entries = next
      },
    }
  }

  it('keeps the old data while loading, then stores the new', async () => {
    const { read, write } = store()
    let resolve: (value: string) => void = () => undefined
    const done = loadEntry(read, write, 'a', () => new Promise<string>((r) => (resolve = r)))
    expect(read().a).toEqual({ data: 'old', loading: true, error: false })
    resolve('new')
    await done
    expect(read().a).toEqual({ data: 'new', loading: false, error: false })
  })

  it('flags a failure and keeps the old data', async () => {
    const { read, write } = store()
    await loadEntry(read, write, 'a', () => Promise.reject(new Error('down')))
    expect(read().a).toEqual({ data: 'old', loading: false, error: true })
  })

  it('writes nothing after settling when no longer current', async () => {
    const { read, write } = store()
    await loadEntry(
      read,
      write,
      'a',
      () => Promise.resolve('new'),
      () => false,
    )
    expect(read().a).toEqual({ data: 'old', loading: true, error: false })
  })
})
