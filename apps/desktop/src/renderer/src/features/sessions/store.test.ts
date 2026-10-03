import type { WorkSession, WorkspaceEvent } from '@milibot/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { stoppableBots, workingCandidates } from '@/features/chat/lib/working'

import { useSessionStore } from './store'

const daemon = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/api/daemon', () => ({ api: () => daemon }))

const WS = 'ws1'

function session(status: WorkSession['status'], lane: WorkSession['lane']['status']): WorkSession {
  return {
    id: 's1',
    botId: 'b1',
    conversationId: 'c1',
    status,
    lane: { status: lane, detail: null },
    steps: { done: 0, total: 0 },
    subagents: { running: 0, total: 0 },
    createdAt: 1,
    updatedAt: 1,
  } as unknown as WorkSession
}

const updated = (s: WorkSession): WorkspaceEvent => ({
  type: 'work_session.updated',
  payload: { session: s },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const stored = () => useSessionStore.getState().sessions.s1

/** What the session's chat shows from the stored lane: the "Working…" row and the composer's "Stop". */
function chatShows() {
  const lane = stored()?.lane
  const input = {
    conversation: { id: 'c1', type: 'session', memberBotIds: ['b1'] },
    bots: { b1: { id: 'b1', status: 'idle' } },
    pending: {},
    botConversation: {},
    lane,
  } as unknown as Parameters<typeof workingCandidates>[0]
  return {
    working: workingCandidates({ ...input, messages: [], isRevealing: () => false }).length > 0,
    stop: stoppableBots(input).length > 0,
  }
}

beforeEach(() => {
  daemon.call.mockReset()
  useSessionStore.setState({ workspaceId: null, sessions: {}, details: {}, laneDetail: {}, list: [] })
  useSessionStore.getState().applyEvent(WS, updated(session('running', 'working')))
})

describe('stopping a session', () => {
  it('ends the turn in the chat when the lane goes idle before the stop request answers', async () => {
    const answer = deferred<WorkSession>()
    daemon.call.mockReturnValueOnce(answer.promise)
    const stopping = useSessionStore.getState().stop(WS, 's1')

    // The daemon announces the stop, then the stopped turn unwinds, before its answer to the request is read.
    useSessionStore.getState().applyEvent(WS, updated(session('cancelled', 'thinking')))
    useSessionStore.getState().applyEvent(WS, updated(session('cancelled', 'idle')))
    answer.resolve(session('cancelled', 'thinking'))
    await stopping

    expect(stored()?.status).toBe('cancelled')
    expect(stored()?.lane.status).toBe('idle')
    expect(chatShows()).toEqual({ working: false, stop: false })
  })

  it('shows the stop from the answer while the events are late, and the idle lane once they come', async () => {
    daemon.call.mockResolvedValueOnce(session('cancelled', 'thinking'))
    await useSessionStore.getState().stop(WS, 's1')
    expect(stored()?.status).toBe('cancelled')

    useSessionStore.getState().applyEvent(WS, updated(session('cancelled', 'thinking')))
    useSessionStore.getState().applyEvent(WS, updated(session('cancelled', 'idle')))
    expect(chatShows()).toEqual({ working: false, stop: false })
  })

  it('keeps the detail of a session stopped while it loaded', async () => {
    const answer = deferred<WorkSession>()
    daemon.call.mockReturnValueOnce(answer.promise)
    const loading = useSessionStore.getState().loadDetail(WS, 's1')
    useSessionStore.getState().applyEvent(WS, updated(session('cancelled', 'idle')))
    answer.resolve({ ...session('running', 'working'), todos: [] } as WorkSession)
    await loading

    expect(stored()?.lane.status).toBe('idle')
    expect(useSessionStore.getState().details.s1).toMatchObject({ status: 'cancelled', todos: [] })
  })
})
