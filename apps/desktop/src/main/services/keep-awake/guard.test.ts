import type { ApiClient, BotStatus, WorkspaceEvent } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KeepAwakeState } from '../../../bridge/contract'
import type { WorkspaceEventSubscriber } from '../workspace-events'
import { KeepAwakeGuard, RESYNC_INTERVAL_MS, SYNC_RETRY_MS, SYNC_TIMEOUT_MS } from './guard'

type ListBots = (
  workspaceId: string,
  signal: AbortSignal,
) => Promise<Array<{ id: string; status: BotStatus }>>

function setup(options: { keepAwake?: boolean; listBots?: ListBots } = {}) {
  let subscriber: WorkspaceEventSubscriber | null = null
  let keepAwakeListener: ((value: boolean) => void) | null = null
  const settings = { keepAwake: options.keepAwake ?? true }
  const listBots = vi.fn<ListBots>(options.listBots ?? (() => Promise.resolve([])))
  const client = {
    call: (name: string, args: { params: { workspaceId: string }; signal: AbortSignal }) => {
      expect(name).toBe('listBots')
      return listBots(args.params.workspaceId, args.signal)
    },
  } as unknown as ApiClient
  const held = new Set<number>()
  let nextId = 1
  const blocker = {
    start: vi.fn(() => {
      held.add(nextId)
      return nextId++
    }),
    stop: vi.fn((id: number) => held.delete(id)),
  }
  const guard = new KeepAwakeGuard({
    feed: { client, subscribe: (s) => (subscriber = s) },
    settings: {
      get keepAwake() {
        return settings.keepAwake
      },
      onKeepAwake: (listener) => (keepAwakeListener = listener),
    },
    blocker,
  })
  const changes: KeepAwakeState[] = []
  guard.onChange((state) => changes.push(state))
  const feed = subscriber as unknown as WorkspaceEventSubscriber
  return {
    guard,
    blocker,
    held,
    listBots,
    changes,
    event: (workspaceId: string, event: WorkspaceEvent) => feed.event(workspaceId, event),
    running: (workspaceId: string) =>
      feed.event(workspaceId, { type: 'runtime.status', payload: { status: 'running' } }),
    status: (workspaceId: string, botId: string, status: BotStatus) =>
      feed.event(workspaceId, { type: 'bot.status', payload: { botId, status } }),
    disconnect: (workspaceId: string) => feed.disconnected?.(workspaceId),
    remove: (workspaceId: string) => feed.removed?.(workspaceId),
    setKeepAwake: (value: boolean) => {
      settings.keepAwake = value
      keepAwakeListener?.(value)
    },
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('KeepAwakeGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('holds one lock while any bot of any workspace works and releases it when all are idle', async () => {
    const t = setup()
    t.running('ws_a')
    t.running('ws_b')
    await flush()
    t.status('ws_a', 'bot_1', 'working')
    t.status('ws_b', 'bot_2', 'thinking')
    expect(t.blocker.start).toHaveBeenCalledTimes(1)
    expect(t.blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(t.guard.state).toEqual({ active: true, busyBots: 2 })
    t.status('ws_a', 'bot_1', 'idle')
    expect(t.held.size).toBe(1)
    t.status('ws_b', 'bot_2', 'idle')
    expect(t.held.size).toBe(0)
    expect(t.guard.state).toEqual({ active: false, busyBots: 0 })
    expect(t.changes.map((c) => c.busyBots)).toEqual([1, 2, 1, 0])
  })

  it('does not count a paused bot', async () => {
    const t = setup()
    t.running('ws_a')
    await flush()
    t.status('ws_a', 'bot_1', 'paused')
    expect(t.guard.state.active).toBe(false)
  })

  it('takes the busy bots of a runtime that is already running from a snapshot', async () => {
    const t = setup({
      listBots: () =>
        Promise.resolve([
          { id: 'bot_1', status: 'working' },
          { id: 'bot_2', status: 'idle' },
        ]),
    })
    t.running('ws_a')
    await flush()
    expect(t.guard.state).toEqual({ active: true, busyBots: 1 })
  })

  it('never reads statuses of a runtime that is not running', async () => {
    const t = setup()
    t.event('ws_a', { type: 'runtime.status', payload: { status: 'stopped' } })
    t.status('ws_a', 'bot_1', 'working')
    await flush()
    expect(t.listBots).not.toHaveBeenCalled()
    expect(t.guard.state.active).toBe(false)
  })

  it('lets an event received during the snapshot win over it', async () => {
    let answer: (bots: Array<{ id: string; status: BotStatus }>) => void = () => undefined
    const t = setup({ listBots: () => new Promise((resolve) => (answer = resolve)) })
    t.running('ws_a')
    t.status('ws_a', 'bot_1', 'idle')
    answer([
      { id: 'bot_1', status: 'working' },
      { id: 'bot_2', status: 'working' },
    ])
    await flush()
    expect(t.guard.state.busyBots).toBe(1)
  })

  it.each([
    ['the socket closes', (t: ReturnType<typeof setup>) => t.disconnect('ws_a')],
    ['the workspace is deleted', (t: ReturnType<typeof setup>) => t.remove('ws_a')],
    [
      'the runtime stops',
      (t: ReturnType<typeof setup>) =>
        t.event('ws_a', { type: 'runtime.status', payload: { status: 'crashed' } }),
    ],
  ])('forgets a workspace when %s', async (_name, drop) => {
    const t = setup()
    t.running('ws_a')
    await flush()
    t.status('ws_a', 'bot_1', 'working')
    expect(t.held.size).toBe(1)
    drop(t)
    expect(t.held.size).toBe(0)
    expect(t.guard.state).toEqual({ active: false, busyBots: 0 })
  })

  it('drops a snapshot answered after the socket closed', async () => {
    let answer: (bots: Array<{ id: string; status: BotStatus }>) => void = () => undefined
    const t = setup({ listBots: () => new Promise((resolve) => (answer = resolve)) })
    t.running('ws_a')
    t.disconnect('ws_a')
    answer([{ id: 'bot_1', status: 'working' }])
    await flush()
    expect(t.guard.state.active).toBe(false)
  })

  it('follows the option: off releases the lock, on takes it back', async () => {
    const t = setup()
    t.running('ws_a')
    await flush()
    t.status('ws_a', 'bot_1', 'working')
    t.setKeepAwake(false)
    expect(t.held.size).toBe(0)
    expect(t.guard.state).toEqual({ active: false, busyBots: 1 })
    t.setKeepAwake(true)
    expect(t.held.size).toBe(1)
  })

  it('never holds the lock with the option off', async () => {
    const t = setup({ keepAwake: false })
    t.running('ws_a')
    await flush()
    t.status('ws_a', 'bot_1', 'working')
    expect(t.blocker.start).not.toHaveBeenCalled()
  })

  it('reads the statuses again while holding the lock and lets go of a stale busy bot', async () => {
    const answers: Array<Array<{ id: string; status: BotStatus }>> = [[], [{ id: 'bot_1', status: 'idle' }]]
    const t = setup({ listBots: () => Promise.resolve(answers.shift() ?? []) })
    t.running('ws_a')
    await flush()
    t.status('ws_a', 'bot_1', 'working')
    expect(t.held.size).toBe(1)
    await vi.advanceTimersByTimeAsync(RESYNC_INTERVAL_MS)
    expect(t.listBots).toHaveBeenCalledTimes(2)
    expect(t.held.size).toBe(0)
  })

  it('drops the statuses of a workspace whose snapshot times out', async () => {
    const t = setup({
      listBots: (_ws, signal) =>
        new Promise((resolve, reject) => {
          if (t.listBots.mock.calls.length === 1) resolve([{ id: 'bot_1', status: 'working' }])
          signal.addEventListener('abort', () => reject(signal.reason as Error))
        }),
    })
    t.running('ws_a')
    await flush()
    expect(t.held.size).toBe(1)
    await vi.advanceTimersByTimeAsync(RESYNC_INTERVAL_MS)
    expect(t.held.size).toBe(1)
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS)
    expect(t.held.size).toBe(0)
    expect(t.guard.state).toEqual({ active: false, busyBots: 0 })
  })

  it('keeps following a workspace after a failed snapshot', async () => {
    const answers: Array<() => Promise<Array<{ id: string; status: BotStatus }>>> = [
      () => Promise.resolve([{ id: 'bot_1', status: 'working' }]),
      () => Promise.reject(new Error('timed out')),
    ]
    const t = setup({ listBots: () => (answers.shift() ?? (() => Promise.resolve([])))() })
    t.running('ws_a')
    await flush()
    await vi.advanceTimersByTimeAsync(RESYNC_INTERVAL_MS)
    expect(t.held.size).toBe(0)
    t.status('ws_a', 'bot_2', 'thinking')
    expect(t.held.size).toBe(1)
    expect(t.guard.state).toEqual({ active: true, busyBots: 1 })
  })

  it('asks for the snapshot again after a failure and takes back a bot still working', async () => {
    const answers: Array<() => Promise<Array<{ id: string; status: BotStatus }>>> = [
      () => Promise.resolve([{ id: 'bot_1', status: 'working' }]),
      () => Promise.reject(new Error('timed out')),
      () => Promise.reject(new Error('timed out')),
      () => Promise.resolve([{ id: 'bot_1', status: 'working' }]),
    ]
    const t = setup({ listBots: () => (answers.shift() ?? (() => Promise.resolve([])))() })
    t.running('ws_a')
    await flush()
    await vi.advanceTimersByTimeAsync(RESYNC_INTERVAL_MS)
    expect(t.held.size).toBe(0)
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_MS)
    expect(t.listBots).toHaveBeenCalledTimes(3)
    expect(t.held.size).toBe(0)
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_MS)
    expect(t.listBots).toHaveBeenCalledTimes(4)
    expect(t.guard.state).toEqual({ active: true, busyBots: 1 })
  })

  it('stops asking again once the workspace is forgotten', async () => {
    const answers: Array<() => Promise<Array<{ id: string; status: BotStatus }>>> = [
      () => Promise.resolve([{ id: 'bot_1', status: 'working' }]),
      () => Promise.reject(new Error('timed out')),
    ]
    const t = setup({ listBots: () => (answers.shift() ?? (() => Promise.resolve([])))() })
    t.running('ws_a')
    await flush()
    await vi.advanceTimersByTimeAsync(RESYNC_INTERVAL_MS)
    t.disconnect('ws_a')
    await vi.advanceTimersByTimeAsync(SYNC_RETRY_MS * 2 + RESYNC_INTERVAL_MS)
    expect(t.listBots).toHaveBeenCalledTimes(2)
  })
})
