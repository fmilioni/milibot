import type {
  Bot,
  BotActivityAction,
  ConversationSummary,
  Message,
  WorkspaceEvent,
  WorkspaceSummary,
} from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import type { MessageThread } from '@/features/workspace/lib/threads'

import { applyWorkspaceEvent, defaultConversation, type WorkspaceEventState } from './workspace-events'

const bot = (id: string, createdAt: number, status: Bot['status'] = 'idle'): Bot =>
  ({ id, name: id, slug: id, status, createdAt }) as Bot

const conversation = (
  id: string,
  type: ConversationSummary['type'],
  memberBotIds: string[],
  lastMessage: Message | null = null,
): ConversationSummary => ({ id, type, memberBotIds, lastMessage }) as ConversationSummary

const message = (id: string, patch: Partial<Message> = {}): Message => ({
  id,
  conversationId: 'dm1',
  authorType: 'bot',
  authorBotId: 'b1',
  kind: 'text',
  content: 'hi',
  payload: null,
  createdAt: 1,
  ...patch,
})

const thread = (items: Message[]): MessageThread => ({
  items,
  hasMore: false,
  loading: false,
  unreadAtOpen: 0,
  loaded: true,
  error: false,
})

function state(patch: Partial<WorkspaceEventState> = {}): WorkspaceEventState {
  return {
    workspaces: [],
    runtimeStatus: 'running',
    status: null,
    vm: null,
    cliUsage: {},
    bots: { b1: bot('b1', 1), b2: bot('b2', 2) },
    statusDetail: {},
    pendingReplies: {},
    botConversation: {},
    statusSession: {},
    activity: {},
    conversations: {
      dm1: conversation('dm1', 'direct', ['b1']),
      dm2: conversation('dm2', 'direct', ['b2']),
      group: conversation('group', 'group', ['b1', 'b2']),
      internal: conversation('internal', 'internal', ['b1', 'b2']),
    },
    sections: [],
    threads: {},
    selectedConversationId: 'dm1',
    ...patch,
  }
}

const apply = (s: WorkspaceEventState, event: WorkspaceEvent, now = 1000) => ({
  ...s,
  ...applyWorkspaceEvent(s, event, now),
})

describe('applyWorkspaceEvent', () => {
  it('upserts the workspace and plain status fields', () => {
    const workspace = { id: 'ws1', name: 'Home' } as WorkspaceSummary
    expect(apply(state(), { type: 'workspace.updated', payload: { workspace } }).workspaces).toEqual([
      workspace,
    ])
    const renamed = { ...workspace, name: 'Work' }
    expect(
      apply(state({ workspaces: [workspace] }), {
        type: 'workspace.updated',
        payload: { workspace: renamed },
      }).workspaces,
    ).toEqual([renamed])
    expect(apply(state(), { type: 'runtime.status', payload: { status: 'stopped' } }).runtimeStatus).toBe(
      'stopped',
    )
  })

  it('returns nothing for events other stores follow', () => {
    expect(applyWorkspaceEvent(state(), { type: 'board.deleted', payload: { boardId: 'brd_1' } })).toEqual({})
  })

  it('adds, replaces and removes bots', () => {
    const b3 = bot('b3', 3)
    expect(apply(state(), { type: 'bot.created', payload: { bot: b3 } }).bots.b3).toBe(b3)
    const gone = apply(state(), { type: 'bot.deleted', payload: { botId: 'b2' } })
    expect(Object.keys(gone.bots)).toEqual(['b1'])
  })

  describe('bot.status', () => {
    it('sets the status, its detail, session and conversation', () => {
      const next = apply(state(), {
        type: 'bot.status',
        payload: {
          botId: 'b1',
          status: 'working',
          detail: 'bash',
          sessionId: 'wks_1',
          conversationId: 'dm1',
        },
      })
      expect(next.bots.b1?.status).toBe('working')
      expect(next.statusDetail.b1).toBeDefined()
      expect(next.statusSession.b1).toBe('wks_1')
      expect(next.botConversation.b1).toBe('dm1')
    })

    it('confirms an optimistic reply only for its conversation', () => {
      const pending = state({ pendingReplies: { b1: { conversationId: 'dm1', at: 5 } } })
      const elsewhere = apply(pending, {
        type: 'bot.status',
        payload: { botId: 'b1', status: 'working', conversationId: 'group' },
      })
      expect(elsewhere.pendingReplies.b1).toEqual({ conversationId: 'dm1', at: 5 })
      const here = apply(pending, {
        type: 'bot.status',
        payload: { botId: 'b1', status: 'thinking', conversationId: 'dm1' },
      })
      expect(here.pendingReplies.b1).toBeUndefined()
      const anywhere = apply(pending, { type: 'bot.status', payload: { botId: 'b1', status: 'thinking' } })
      expect(anywhere.pendingReplies.b1).toBeUndefined()
    })

    it('leaves the bots alone for a bot it does not know', () => {
      const patch = applyWorkspaceEvent(state(), {
        type: 'bot.status',
        payload: { botId: 'bx', status: 'idle' },
      })
      expect(patch.bots).toBeUndefined()
    })
  })

  it('keeps the activity of loaded bots, without repeats and capped', () => {
    const action = (id: string) => ({ id }) as BotActivityAction
    const event = (a: BotActivityAction): WorkspaceEvent => ({
      type: 'bot.activity',
      payload: { botId: 'b1', action: a },
    })
    expect(applyWorkspaceEvent(state(), event(action('a1')))).toEqual({})
    const loaded = state({ activity: { b1: [action('a1'), action('a2')] } })
    expect(apply(loaded, event(action('a1'))).activity.b1?.map((a) => a.id)).toEqual(['a2', 'a1'])
    const full = state({ activity: { b1: Array.from({ length: 200 }, (_, i) => action(`x${i}`)) } })
    const capped = apply(full, event(action('new'))).activity.b1 ?? []
    expect(capped).toHaveLength(200)
    expect(capped.at(-1)?.id).toBe('new')
  })

  describe('conversation.deleted', () => {
    it('selects the default conversation when the selected one goes', () => {
      const next = apply(state(), { type: 'conversation.deleted', payload: { conversationId: 'dm1' } })
      expect(next.conversations.dm1).toBeUndefined()
      expect(next.selectedConversationId).toBe('dm2')
    })

    it('keeps the selection when another one goes', () => {
      const patch = applyWorkspaceEvent(state(), {
        type: 'conversation.deleted',
        payload: { conversationId: 'group' },
      })
      expect(patch.selectedConversationId).toBeUndefined()
      expect(Object.keys(patch.conversations ?? {})).toEqual(['dm1', 'dm2', 'internal'])
    })
  })

  describe('message.created', () => {
    it('merges into a loaded thread in id order, once', () => {
      const s = state({ threads: { dm1: thread([message('m1'), message('m3')]) } })
      const next = apply(s, { type: 'message.created', payload: { message: message('m2') } })
      expect(next.threads.dm1?.items.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
      const again = apply(next, { type: 'message.created', payload: { message: message('m2') } })
      expect(again.threads.dm1?.items.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    })

    it('leaves threads not loaded and places the bot in the conversation', () => {
      const patch = applyWorkspaceEvent(state(), {
        type: 'message.created',
        payload: { message: message('m1', { conversationId: 'group', authorBotId: 'b2' }) },
      })
      expect(patch.threads).toBeUndefined()
      expect(patch.botConversation).toEqual({ b2: 'group' })
    })

    it('shows the other member of an internal conversation working until it answers', () => {
      const next = apply(
        state(),
        { type: 'message.created', payload: { message: message('m1', { conversationId: 'internal' }) } },
        42,
      )
      expect(next.pendingReplies.b2).toEqual({ conversationId: 'internal', at: 42 })
      expect(next.bots.b2?.status).toBe('thinking')
      expect(next.botConversation).toEqual({ b1: 'internal', b2: 'internal' })
    })
  })

  it('keeps a bot busy in its DM placed there when its parallel session updates its activity', () => {
    const s = state({
      bots: { b1: bot('b1', 1, 'working'), b2: bot('b2', 2) },
      botConversation: { b1: 'dm1' },
      conversations: { ...state().conversations, ses1: conversation('ses1', 'session', ['b1']) },
    })
    const activity = message('a1', { conversationId: 'ses1', kind: 'activity' })
    const created = apply(s, { type: 'message.created', payload: { message: activity } })
    const updated = apply(created, { type: 'message.updated', payload: { message: activity } })
    const text = apply(updated, {
      type: 'message.created',
      payload: { message: message('t1', { conversationId: 'ses1' }) },
    })
    expect(text.botConversation).toEqual({ b1: 'dm1' })
  })

  it('does not move a bot on its own activity cards (its lane status places it)', () => {
    const next = apply(state({ botConversation: { b1: 'dm1' } }), {
      type: 'message.updated',
      payload: { message: message('a1', { conversationId: 'group', kind: 'activity' }) },
    })
    expect(next.botConversation).toEqual({ b1: 'dm1' })
  })

  it('replaces, streams into and removes messages in threads and previews', () => {
    const m1 = message('m1', { content: 'Hel' })
    const s = state({
      threads: { dm1: thread([m1]) },
      conversations: { dm1: conversation('dm1', 'direct', ['b1'], m1) },
    })
    const streamed = apply(s, {
      type: 'message.delta',
      payload: { conversationId: 'dm1', messageId: 'm1', delta: 'lo' },
    })
    expect(streamed.threads.dm1?.items[0]?.content).toBe('Hello')
    expect(streamed.conversations.dm1?.lastMessage?.content).toBe('Hello')

    const final = { ...m1, content: 'Hello!' }
    const updated = apply(streamed, { type: 'message.updated', payload: { message: final } })
    expect(updated.threads.dm1?.items).toEqual([final])
    expect(updated.conversations.dm1?.lastMessage).toBe(final)

    const removed = apply(updated, {
      type: 'message.deleted',
      payload: { conversationId: 'dm1', messageId: 'm1' },
    })
    expect(removed.threads.dm1?.items).toEqual([])
    expect(
      applyWorkspaceEvent(s, { type: 'message.deleted', payload: { conversationId: 'dm2', messageId: 'x' } }),
    ).toEqual({})
  })
})

describe('defaultConversation', () => {
  it("is the first bot's DM, else any DM or group", () => {
    const bots = { b1: bot('b1', 2), b2: bot('b2', 1) }
    const list = [conversation('dm1', 'direct', ['b1']), conversation('dm2', 'direct', ['b2'])]
    expect(defaultConversation(list, bots)).toBe('dm2')
    expect(defaultConversation([conversation('g', 'group', ['b1'])], bots)).toBe('g')
    expect(defaultConversation([conversation('i', 'internal', ['b1', 'b2'])], bots)).toBeNull()
  })
})
