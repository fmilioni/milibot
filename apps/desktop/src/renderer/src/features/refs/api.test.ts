import type { RefInfo } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const daemon = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/api/daemon', () => ({ api: () => ({ call: daemon.call }) }))

import { loadRef, RESOLVE_WINDOW_MS } from './api'

const idOf = (n: number) => `bcd_01m41qvydqnjxef4ax623h${String(n).padStart(4, '0')}`
const sentIds = () =>
  daemon.call.mock.calls.flatMap((call) => (call[1] as { body: { ids: string[] } }).body.ids)

let workspace = 0

beforeEach(() => {
  vi.useFakeTimers()
  workspace += 1
  daemon.call.mockReset()
  daemon.call.mockImplementation(async (_name: string, input: { body: { ids: string[] } }) => ({
    refs: input.body.ids.map((id): RefInfo => ({ id, kind: 'card', name: `name ${id}` })),
  }))
})

afterEach(() => vi.useRealTimers())

describe('loadRef', () => {
  it('sends the ids of a message rendered at once in one call, right away', async () => {
    const ws = `ws${workspace}`
    const answers = Array.from({ length: 17 }, (_, n) => loadRef(ws, idOf(n)))
    await vi.advanceTimersByTimeAsync(0)
    expect(daemon.call).toHaveBeenCalledTimes(1)
    expect((await answers[16])?.name).toBe(`name ${idOf(16)}`)
  })

  it('groups ids that stream in one by one instead of one call per id', async () => {
    const ws = `ws${workspace}`
    const answers: Promise<RefInfo | null>[] = []
    for (let n = 0; n < 40; n++) {
      answers.push(loadRef(ws, idOf(n)))
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(RESOLVE_WINDOW_MS)
    expect(daemon.call.mock.calls.length).toBeLessThanOrEqual(Math.ceil((40 * 100) / RESOLVE_WINDOW_MS) + 1)
    expect(new Set(sentIds()).size).toBe(40)
    expect(sentIds()).toHaveLength(40)
    expect((await Promise.all(answers)).every((info) => info?.name.startsWith('name '))).toBe(true)
  })

  it('asks for an id once while it is waiting or in flight', async () => {
    const ws = `ws${workspace}`
    let answer: (value: { refs: RefInfo[] }) => void = () => undefined
    daemon.call.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const first = loadRef(ws, idOf(1))
    expect(loadRef(ws, idOf(1))).toBe(first)
    await vi.advanceTimersByTimeAsync(0)
    expect(loadRef(ws, idOf(1))).toBe(first)
    await vi.advanceTimersByTimeAsync(RESOLVE_WINDOW_MS)
    expect(daemon.call).toHaveBeenCalledTimes(1)
    answer({ refs: [{ id: idOf(1), kind: 'card', name: 'one' }] })
    expect((await first)?.name).toBe('one')
  })
})
