import type { Bot, ConversationSummary, Message } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  internalWakeTarget,
  pausedWaiting,
  replyTargets,
  stoppableBots,
  workingCandidates,
  type WorkingInput,
} from './working'

// Portuguese on purpose: asserts the @todos mention.

function bot(id: string, name: string, status: Bot['status'] = 'idle'): Bot {
  return { id, name, slug: name.toLowerCase(), status } as Bot
}

function conversation(type: ConversationSummary['type'], memberBotIds: string[]): ConversationSummary {
  return { id: 'conv_1', type, memberBotIds } as ConversationSummary
}

function message(overrides: Partial<Message>): Message {
  return {
    id: 'msg_1',
    conversationId: 'conv_1',
    authorType: 'bot',
    authorBotId: 'b1',
    kind: 'text',
    content: '',
    payload: null,
    createdAt: 1,
    ...overrides,
  }
}

describe('replyTargets', () => {
  const bots = { b1: bot('b1', 'Iris'), b2: bot('b2', 'Chief') }

  it('wakes the bot of a direct conversation', () => {
    expect(replyTargets(conversation('direct', ['b1']), 'hi', bots)).toEqual(['b1'])
  })

  it('wakes only mentioned bots in groups', () => {
    const group = conversation('group', ['b1', 'b2'])
    expect(replyTargets(group, 'hi @iris', bots)).toEqual(['b1'])
    expect(replyTargets(group, 'hi everyone', bots)).toEqual([])
    expect(replyTargets(conversation('internal', ['b1', 'b2']), '@Iris', bots)).toEqual([])
    expect(replyTargets(conversation('group', ['b1']), 'hi', bots)).toEqual(['b1'])
    expect(replyTargets(group, '@todos good morning', bots)).toEqual(['b1', 'b2'])
  })
})

describe('workingCandidates', () => {
  const base = (overrides: Partial<WorkingInput>): WorkingInput => ({
    conversation: conversation('direct', ['b1']),
    bots: { b1: bot('b1', 'Iris', 'thinking') },
    pending: {},
    botConversation: { b1: 'conv_1' },
    messages: [message({ authorType: 'user', authorBotId: null, content: 'hi' })],
    isRevealing: () => false,
    ...overrides,
  })

  it('shows a busy bot working in this conversation', () => {
    expect(workingCandidates(base({}))).toEqual([{ botId: 'b1', immediate: false }])
  })

  it('shows right away after sending, even before the status arrives', () => {
    const input = base({ bots: { b1: bot('b1', 'Iris') }, pending: { b1: { conversationId: 'conv_1' } } })
    expect(workingCandidates(input)).toEqual([{ botId: 'b1', immediate: true }])
  })

  it('ignores bots idle, paused or busy elsewhere', () => {
    expect(workingCandidates(base({ bots: { b1: bot('b1', 'Iris') } }))).toEqual([])
    expect(workingCandidates(base({ bots: { b1: bot('b1', 'Iris', 'paused') } }))).toEqual([])
    expect(workingCandidates(base({ botConversation: { b1: 'conv_2' } }))).toEqual([])
  })

  it('hides once the reply starts streaming and while it types out', () => {
    const streaming = message({ content: 'Hello', payload: { type: 'text', streaming: true, turnId: null } })
    expect(workingCandidates(base({ messages: [streaming] }))).toEqual([])
    const done = message({ content: 'Hello', payload: { type: 'text', streaming: false, turnId: null } })
    expect(workingCandidates(base({ messages: [done], isRevealing: () => true }))).toEqual([])
    expect(workingCandidates(base({ messages: [done] }))).toEqual([{ botId: 'b1', immediate: false }])
  })

  it('keeps showing while the reply has not received its first delta', () => {
    const empty = message({ content: '', payload: { type: 'text', streaming: true, turnId: null } })
    expect(workingCandidates(base({ messages: [empty] }))).toEqual([{ botId: 'b1', immediate: false }])
  })
})

describe('stoppableBots', () => {
  const group = conversation('group', ['b1', 'b2', 'b3'])
  const bots = {
    b1: bot('b1', 'Iris', 'working'),
    b2: bot('b2', 'Rui', 'talking'),
    b3: bot('b3', 'Ana', 'thinking'),
  }

  it('stops only the bots working on this conversation', () => {
    const input = { conversation: group, bots, pending: {}, botConversation: { b1: 'conv_1', b3: 'conv_2' } }
    expect(stoppableBots(input)).toEqual(['b1'])
  })

  it('includes a bot just asked here and one streaming its reply', () => {
    const input = {
      conversation: group,
      bots,
      pending: { b3: { conversationId: 'conv_1' } },
      botConversation: { b2: 'conv_1', b3: 'conv_2' },
    }
    expect(stoppableBots(input)).toEqual(['b2', 'b3'])
  })

  it('never offers idle or paused bots, nor internal conversations', () => {
    const idle = { b1: bot('b1', 'Iris'), b2: bot('b2', 'Rui', 'paused') }
    const botConversation = { b1: 'conv_1', b2: 'conv_1' }
    expect(stoppableBots({ conversation: group, bots: idle, pending: {}, botConversation })).toEqual([])
    const internal = conversation('internal', ['b1', 'b2'])
    expect(stoppableBots({ conversation: internal, bots, pending: {}, botConversation })).toEqual([])
  })

  it('in a DM, also a busy bot whose conversation is unknown (busy before the window loaded)', () => {
    const dm = conversation('direct', ['b1'])
    expect(stoppableBots({ conversation: dm, bots, pending: {}, botConversation: {} })).toEqual(['b1'])
    expect(stoppableBots({ conversation: dm, bots, pending: {}, botConversation: { b1: 'conv_2' } })).toEqual(
      [],
    )
    expect(stoppableBots({ conversation: group, bots, pending: {}, botConversation: {} })).toEqual([])
  })
})

describe('session conversations', () => {
  const session = conversation('session', ['b1'])
  const chatBusy = { b1: bot('b1', 'Iris', 'working') }
  const idle = { b1: bot('b1', 'Iris') }

  it('follow the session lane, not the bot status (which may be a chat)', () => {
    const base = { conversation: session, pending: {}, botConversation: { b1: 'conv_2' } }
    expect(stoppableBots({ ...base, bots: chatBusy, lane: { status: 'idle' } })).toEqual([])
    expect(stoppableBots({ ...base, bots: idle, lane: { status: 'working' } })).toEqual(['b1'])
    expect(
      stoppableBots({
        ...base,
        bots: idle,
        pending: { b1: { conversationId: 'conv_1' } },
        lane: { status: 'idle' },
      }),
    ).toEqual(['b1'])
    const input = { ...base, messages: [], isRevealing: () => false, statusSession: { b1: 'wks_1' } }
    expect(workingCandidates({ ...input, bots: idle, lane: { status: 'thinking' } })).toEqual([
      { botId: 'b1', immediate: false },
    ])
    expect(workingCandidates({ ...input, bots: chatBusy, lane: { status: 'idle' } })).toEqual([])
  })
})

describe('pausedWaiting', () => {
  const user = (createdAt: number, content = 'hi') =>
    message({ id: `u${createdAt}`, authorType: 'user', authorBotId: null, content, createdAt })
  const reply = (createdAt: number) => message({ id: `b${createdAt}`, content: 'done', createdAt })

  it('lists a paused bot the user wrote to after its last reply', () => {
    const bots = { b1: bot('b1', 'Iris', 'paused') }
    const dm = conversation('direct', ['b1'])
    expect(pausedWaiting(dm, bots, [reply(1), user(2)])).toEqual(['b1'])
    expect(pausedWaiting(dm, bots, [user(1), reply(2)])).toEqual([])
    expect(pausedWaiting(dm, { b1: bot('b1', 'Iris') }, [user(1)])).toEqual([])
  })

  it('in a group, only for the paused bots the message is for', () => {
    const bots = { b1: bot('b1', 'Iris', 'paused'), b2: bot('b2', 'Rui', 'paused') }
    const group = { ...conversation('group', ['b1', 'b2']), settings: {} } as ConversationSummary
    expect(pausedWaiting(group, bots, [user(1, '@Rui can you check?')])).toEqual(['b2'])
  })
})

describe('internal conversations', () => {
  const bots = { b1: bot('b1', 'Ana', 'working'), b2: bot('b2', 'Iris') }
  const internal = conversation('internal', ['b1', 'b2'])
  const ask = message({
    authorBotId: 'b1',
    content: 'IPCA?',
    payload: { type: 'text', streaming: false, turnId: 't' },
  })

  it('wakes the free peer when a bot posts its question there', () => {
    expect(internalWakeTarget(internal, ask, bots)).toBe('b2')
    expect(internalWakeTarget(internal, ask, { ...bots, b2: bot('b2', 'Iris', 'working') })).toBeNull()
    expect(internalWakeTarget(conversation('direct', ['b1']), ask, bots)).toBeNull()
    expect(internalWakeTarget(undefined, ask, bots)).toBeNull()
  })

  it('does not wake anyone for streamed replies', () => {
    const reply = message({
      authorBotId: 'b2',
      content: '',
      payload: { type: 'text', streaming: true, turnId: 't' },
    })
    expect(internalWakeTarget(internal, reply, { ...bots, b1: bot('b1', 'Ana') })).toBeNull()
  })

  it('shows the working row of the bot answering there', () => {
    const input: WorkingInput = {
      conversation: internal,
      bots: { b1: bot('b1', 'Ana', 'working'), b2: bot('b2', 'Iris', 'thinking') },
      pending: {},
      botConversation: { b1: 'conv_origin', b2: 'conv_1' },
      messages: [ask],
      isRevealing: () => false,
    }
    expect(workingCandidates(input)).toEqual([{ botId: 'b2', immediate: false }])
  })
})
