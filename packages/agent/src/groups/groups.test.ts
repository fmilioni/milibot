import { type Bot, GROUP_SETTING_KEYS, type Message } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { DefaultAgentHost } from '../host/agent-host'
import { FakeProvider, type FakeStep } from '../llm/fake'
import type { CompletionRequest } from '../llm/provider'
import { TRIAGE_SYSTEM_PROMPT } from '../prompts/triage'
import { makeBot, TestEnv } from '../test-support/env'
import { botStreak, parseTriageResponse, planGroupRoute } from './routing'

// Portuguese on purpose: pt names (Zé, Maringá) check that non-ASCII bot references and tasks pass through.

const ana = makeBot({ name: 'Ana', slug: 'ana', label: 'Dev', systemPrompt: 'You write code.' })
const iris = makeBot({
  name: 'Iris',
  slug: 'iris',
  label: 'Research',
  systemPrompt: 'You research.',
  displayNum: 2,
})
const lia = makeBot({
  name: 'Lia',
  slug: 'lia',
  label: 'Finance',
  systemPrompt: 'You do finance.',
  displayNum: 3,
})

function msg(overrides: Partial<Message>): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    conversationId: 'cnv_g',
    authorType: 'user',
    authorBotId: null,
    kind: 'text',
    content: '',
    payload: null,
    createdAt: 1,
    ...overrides,
  }
}

function systemText(request: CompletionRequest): string {
  const system = request.messages.find((m) => m.role === 'system')
  return system?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
}

function lastUserText(request: CompletionRequest): string {
  const users = request.messages.filter((m) => m.role === 'user' || m.role === 'tool')
  return (users.at(-1)?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
}

type Scripts = Record<string, (request: CompletionRequest, call: number) => FakeStep>

/** One provider for every bot: dispatches on the "You are <Name>" line of the system prompt. */
async function setup(bots: Bot[], scripts: Scripts, triage?: (request: CompletionRequest) => FakeStep) {
  const calls: Record<string, number> = {}
  const provider = new FakeProvider({
    script: (request) => {
      const system = systemText(request)
      const bot = bots.find((b) => system.includes(`You are ${b.name}`))
      if (!bot) throw new Error('unknown bot in request')
      const n = (calls[bot.slug] = (calls[bot.slug] ?? -1) + 1)
      return scripts[bot.slug]?.(request, n) ?? { text: `${bot.name} ok` }
    },
  })
  const env = new TestEnv(provider)
  const triageProvider = new FakeProvider({
    script: (request) => triage?.(request) ?? { text: '{"respond": []}' },
  })
  env.triageProvider = triageProvider
  for (const bot of bots) env.addBot(bot)
  const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
  await host.start(env)
  return { env, host, provider, triageProvider }
}

const texts = (env: TestEnv, conversationId: string) =>
  env.messages
    .filter((m) => m.conversationId === conversationId && m.kind === 'text')
    .map((m) => [m.authorType === 'user' ? 'user' : env.getBot(m.authorBotId ?? '')?.name, m.content])

describe('planGroupRoute', () => {
  const bots = new Map([ana, iris, lia].map((b) => [b.id, b]))
  const group = new TestEnv(new FakeProvider({ script: [] })).addGroup([ana.id, iris.id, lia.id])
  const base = { conversation: group, bots, now: 100_000, lastSpokeAt: () => null, cooldownMs: 20_000 }

  it('enqueues mentions and triages the rest; single-bot groups skip triage', () => {
    const message = msg({ content: '@Ana fix the build' })
    expect(planGroupRoute({ ...base, message, recent: [message] })).toEqual({
      enqueue: [ana.id],
      triage: [iris.id, lia.id],
    })
    const solo = { ...group, memberBotIds: [iris.id] }
    const plain = msg({ content: 'look into this' })
    expect(planGroupRoute({ ...base, conversation: solo, message: plain, recent: [plain] })).toEqual({
      enqueue: [iris.id],
      triage: [],
    })
  })

  it('does not triage when the group answers only mentions', () => {
    const conversation = { ...group, settings: { respondWithoutMention: false } }
    const message = msg({ content: 'anyone?' })
    expect(planGroupRoute({ ...base, conversation, message, recent: [message] })).toEqual({
      enqueue: [],
      triage: [],
    })
  })

  it('guards bot messages: author excluded, streak limit, mentions only near it, cooldown', () => {
    const conversation = { ...group, settings: { maxConsecutiveBotMessages: 4 } }
    const fromAna = (content: string) => msg({ authorType: 'bot', authorBotId: ana.id, content })
    const one = fromAna('@Iris can you check?')
    expect(
      planGroupRoute({ ...base, conversation, message: one, recent: [msg({ content: 'hi' }), one] }),
    ).toEqual({ enqueue: [iris.id], triage: [lia.id] })
    const cooled = planGroupRoute({
      ...base,
      conversation,
      message: one,
      recent: [one],
      lastSpokeAt: (id) => (id === lia.id ? 95_000 : null),
    })
    expect(cooled.triage).toEqual([])
    const near = [fromAna('a'), fromAna('b'), one]
    expect(botStreak(near)).toBe(3)
    expect(planGroupRoute({ ...base, conversation, message: one, recent: near })).toEqual({
      enqueue: [iris.id],
      triage: [],
    })
    const over = [fromAna('a'), fromAna('b'), fromAna('c'), one]
    expect(planGroupRoute({ ...base, conversation, message: one, recent: over })).toEqual({
      enqueue: [],
      triage: [],
      skipped: 'bot_streak_limit',
    })
  })

  it('parses triage answers', () => {
    expect(parseTriageResponse('```json\n{"respond": ["iris", "@Lia", "joe"]}\n```', [iris, lia])).toEqual([
      iris.id,
      lia.id,
    ])
    expect(parseTriageResponse('{"respond": []}', [iris])).toEqual([])
    expect(parseTriageResponse('nobody', [iris])).toBeNull()
  })
})

describe('group routing in the host', () => {
  it('lets triage pick who answers a message without mentions and logs it as a cheap call', async () => {
    const { env, host, triageProvider } = await setup([ana, iris, lia], {}, () => ({
      text: '{"respond": ["iris"]}',
    }))
    const group = env.addGroup([ana.id, iris.id, lia.id], {}, 'Team')
    host.onMessageCreated(env.userMessage(group.id, 'what was inflation in August?'))
    await host.idle()
    expect(texts(env, group.id)).toEqual([
      ['user', 'what was inflation in August?'],
      ['Iris', 'Iris ok'],
    ])
    const triage = env.llmCalls.filter((c) => c.purpose === 'triage')
    // One triage for the user message; Iris' reply wakes nobody (Ana and Lia are asked, choose none).
    expect(triage.map((c) => [c.botId, c.conversationId])).toEqual([
      [null, group.id],
      [null, group.id],
    ])
    expect(systemText(triageProvider.requests[0] as CompletionRequest)).toBe(TRIAGE_SYSTEM_PROMPT)
    const prompt = lastUserText(triageProvider.requests[0] as CompletionRequest)
    expect(prompt).toContain('- iris: Iris (Research)')
    expect(prompt).toContain('what was inflation in August?')
  })

  it('shows nothing when triage ignores the message, and skips triage when the group only answers mentions', async () => {
    const { env, host } = await setup([ana, iris], {})
    const group = env.addGroup([ana.id, iris.id])
    host.onMessageCreated(env.userMessage(group.id, 'ok, thanks'))
    await host.idle()
    expect(texts(env, group.id)).toEqual([['user', 'ok, thanks']])
    expect(env.llmCalls.map((c) => c.purpose)).toEqual(['triage'])

    const quiet = env.addGroup([ana.id, iris.id], { respondWithoutMention: false })
    host.onMessageCreated(env.userMessage(quiet.id, 'good morning'))
    host.onMessageCreated(env.userMessage(quiet.id, '@Ana good morning'))
    await host.idle()
    expect(texts(env, quiet.id).map((t) => t[0])).toEqual(['user', 'user', 'Ana'])
    expect(env.llmCalls.filter((c) => c.purpose === 'triage')).toHaveLength(1)
  })

  it('stops bot ping-pong at the streak limit', async () => {
    const { env, host } = await setup([ana, iris], {
      ana: (_r, n) => ({ text: `@Iris what now? ${n}` }),
      iris: (_r, n) => ({ text: `@Ana go on ${n}` }),
    })
    const group = env.addGroup([ana.id, iris.id], { maxConsecutiveBotMessages: 3 })
    host.onMessageCreated(env.userMessage(group.id, '@Ana start'))
    await host.idle()
    expect(texts(env, group.id)).toEqual([
      ['user', '@Ana start'],
      ['Ana', '@Iris what now? 0'],
      ['Iris', '@Ana go on 0'],
      ['Ana', '@Iris what now? 1'],
    ])
  })
})

describe('ask_bot / message_bot', () => {
  it('ask_bot runs the other bot in their internal conversation and returns its reply', async () => {
    const { env, host, provider } = await setup([ana, iris], {
      ana: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'ask_bot', arguments: { bot: 'iris', message: 'August CPI?' } }] }
          : { text: 'Iris said 0.2%.' },
      iris: () => ({ text: 'It was 0.2% (BLS).' }),
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'ask Iris for the CPI'))
    await host.idle()

    const internal = [...env.conversations.values()].find((c) => c.type === 'internal')
    if (!internal) throw new Error('no internal conversation')
    expect(internal.memberBotIds).toEqual([ana.id, iris.id])
    expect(texts(env, internal.id)).toEqual([
      ['Ana', 'August CPI?'],
      ['Iris', 'It was 0.2% (BLS).'],
    ])
    const irisRequest = provider.requests.find((r) => systemText(r).includes('You are Iris'))
    expect(lastUserText(irisRequest as CompletionRequest)).toContain('Private conversation with Ana')
    const anaSecond = provider.requests.filter((r) => systemText(r).includes('You are Ana'))[1]
    expect(lastUserText(anaSecond as CompletionRequest)).toContain('Iris replied:\n\nIt was 0.2% (BLS).')

    const card = env.messages.find((m) => m.payload?.type === 'bot_message_sent')
    expect(card?.conversationId).toBe(dm)
    expect(card?.payload).toMatchObject({
      targetBotId: iris.id,
      internalConversationId: internal.id,
      awaitReply: true,
      status: 'replied',
      replyPreview: 'It was 0.2% (BLS).',
    })
    expect(texts(env, dm).at(-1)).toEqual(['Ana', 'Iris said 0.2%.'])
    expect(env.statuses).toContainEqual({
      botId: ana.id,
      status: 'working',
      detail: 'ask_bot',
      targetBotId: iris.id,
      conversationId: dm,
    })
    // Iris's own chat shows the message too, linked to their private conversation.
    const received = env.messages.find((m) => m.payload?.type === 'bot_message_received')
    expect(received?.conversationId).toBe(env.findDirectConversation(iris.id)?.id)
    expect(received?.payload).toMatchObject({
      fromBotId: ana.id,
      internalConversationId: internal.id,
      status: 'replied',
    })
  })

  it('message_bot returns at once and the reply wakes the sender in its conversation', async () => {
    const { env, host, provider } = await setup([ana, iris], {
      ana: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'message_bot', arguments: { bot: 'Iris', message: 'Look up the CPI.' } }] }
          : { text: n === 1 ? 'Asked Iris.' : 'It came in: 0.2%.' },
      iris: () => ({ text: '0.2% in August.', delayMs: 20 }),
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'ask Iris for the CPI'))
    await host.idle()
    expect(texts(env, dm)).toEqual([
      ['user', 'ask Iris for the CPI'],
      ['Ana', 'Asked Iris.'],
      ['Ana', 'It came in: 0.2%.'],
    ])
    const toolResult = provider.requests.filter((r) => systemText(r).includes('You are Ana'))[1]
    expect(lastUserText(toolResult as CompletionRequest)).toContain('Its reply will arrive later')
    const wake = provider.requests.filter((r) => systemText(r).includes('You are Ana'))[2]
    expect(lastUserText(wake as CompletionRequest)).toContain('Iris replied to your message')
    expect(lastUserText(wake as CompletionRequest)).toContain('0.2% in August.')
  })

  it('message_bot as an update runs the target but sends nothing back', async () => {
    const { env, host, provider } = await setup([ana, iris], {
      ana: (_r, n) =>
        n === 0
          ? {
              toolCalls: [
                {
                  name: 'message_bot',
                  arguments: { bot: 'iris', message: 'The design moved to v2.', expects_reply: false },
                },
              ],
            }
          : { text: 'Told Iris.' },
      iris: () => ({ text: 'Noted, updating my notes.' }),
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'tell Iris'))
    await host.idle()
    const anaRequests = provider.requests.filter((r) => systemText(r).includes('You are Ana'))
    expect(anaRequests).toHaveLength(2)
    expect(lastUserText(anaRequests[1] as CompletionRequest)).toContain('nothing comes back to you')
    const irisRequest = provider.requests.find((r) => systemText(r).includes('You are Iris'))
    expect(lastUserText(irisRequest as CompletionRequest)).toContain('expects no reply')
    const card = env.messages.find((m) => m.payload?.type === 'bot_message_sent')?.payload
    expect(card).toMatchObject({ notice: true, status: 'delivered' })
    expect(texts(env, dm).map((t) => t[1])).toEqual(['tell Iris', 'Told Iris.'])
  })

  it('pauses a long bot exchange for the user, who lets it go on', async () => {
    const { env, host } = await setup([ana, iris], {
      ana: (request) =>
        /Sent to|Not sent yet/.test(lastUserText(request))
          ? { text: 'ana waits' }
          : { toolCalls: [{ name: 'message_bot', arguments: { bot: 'iris', message: 'one more thing' } }] },
      iris: () => ({ text: 'iris answers' }),
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'work with Iris'))
    await host.idle()
    const sent = () => env.messages.filter((m) => m.payload?.type === 'bot_message_sent').length
    expect(sent()).toBe(3)
    expect(env.confirmations).toMatchObject([
      {
        botId: ana.id,
        conversationId: dm,
        action: 'continue_bot_exchange',
        params: { botId: iris.id, botName: 'Iris' },
        reason: 'one more thing',
      },
    ])
    const heldId = String(env.confirmations[0]?.data.heldId)
    expect(host.resumeBotMessage(heldId)).toBe(true)
    expect(host.resumeBotMessage(heldId)).toBe(false)
    await host.idle()
    expect(sent()).toBe(6)
    expect(env.confirmations).toHaveLength(2)
  })

  it('ask_bot times out, and the late reply still reaches the sender', async () => {
    const { env, host, provider } = await setup([ana, iris], {
      ana: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'ask_bot', arguments: { bot: 'iris', message: 'slow?' } }] }
          : { text: `ana ${n}` },
      iris: () => ({ text: 'answered late', delayMs: 150 }),
    })
    env.settings[GROUP_SETTING_KEYS.askTimeoutSeconds] = 0.03
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'question'))
    await host.idle()
    const anaRequests = provider.requests.filter((r) => systemText(r).includes('You are Ana'))
    expect(lastUserText(anaRequests[1] as CompletionRequest)).toContain('did not answer within 0.03 s')
    expect(lastUserText(anaRequests[2] as CompletionRequest)).toContain('answered late')
    expect(texts(env, dm).map((t) => t[1])).toEqual(['question', 'ana 1', 'ana 2'])
  })

  it('delivers a follow-up written in the internal conversation after the answer to the asker', async () => {
    const { env, host, provider } = await setup([ana, iris, lia], {
      ana: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'ask_bot', arguments: { bot: 'iris', message: 'August CPI?' } }] }
          : { text: n === 1 ? 'Iris will confirm.' : 'Confirmed: 0.3%.' },
      iris: (_r, n) =>
        n === 0
          ? {
              toolCalls: [
                { name: 'message_bot', arguments: { bot: 'lia', message: 'Can you check the CPI?' } },
              ],
            }
          : { text: n === 1 ? 'I will confirm with Lia.' : 'Lia confirmed: 0.3%.' },
      lia: () => ({ text: '0.3%.', delayMs: 20 }),
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'ask Iris'))
    await host.idle()

    const internal = [...env.conversations.values()].find(
      (c) => c.type === 'internal' && c.memberBotIds.includes(ana.id),
    )
    expect(texts(env, internal?.id as string).map((t) => t[1])).toEqual([
      'August CPI?',
      'I will confirm with Lia.',
      'Lia confirmed: 0.3%.',
    ])
    const anaRequests = provider.requests.filter((r) => systemText(r).includes('You are Ana'))
    expect(lastUserText(anaRequests.at(-1) as CompletionRequest)).toContain(
      'Iris sent a follow-up in your private conversation',
    )
    expect(lastUserText(anaRequests.at(-1) as CompletionRequest)).toContain('Lia confirmed: 0.3%.')
    expect(texts(env, dm).map((t) => t[1])).toEqual(['ask Iris', 'Iris will confirm.', 'Confirmed: 0.3%.'])
  })

  it('does not treat replies as follow-ups, and stops forwarding after too many hops', async () => {
    const { env, host, provider } = await setup([ana, iris], {
      ana: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'message_bot', arguments: { bot: 'iris', message: 'hi' } }] }
          : { text: `ana ${n}` },
      iris: () => ({ text: 'iris' }),
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'go'))
    await host.idle()
    const anaTurns = () => provider.requests.filter((r) => systemText(r).includes('You are Ana')).length
    expect(anaTurns()).toBe(3)

    const internal = env.internalConversation(ana.id, iris.id)
    host.enqueueTurn({
      botId: iris.id,
      conversationId: internal.id,
      trigger: 'bot_reply',
      note: 'x',
      hops: 8,
    })
    await host.idle()
    expect(anaTurns()).toBe(3)
    host.enqueueTurn({
      botId: iris.id,
      conversationId: internal.id,
      trigger: 'bot_reply',
      note: 'x',
      hops: 2,
    })
    await host.idle()
    expect(anaTurns()).toBe(4)
    expect(texts(env, dm).at(-1)).toEqual(['Ana', 'ana 3'])
  })

  it('refuses cycles: a bot cannot ask back the bot that is waiting on it', async () => {
    const { env, host, provider } = await setup([ana, iris], {
      ana: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'ask_bot', arguments: { bot: 'iris', message: 'X?' } }] }
          : { text: 'ok' },
      iris: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'ask_bot', arguments: { bot: 'ana', message: 'and you?' } }] }
          : { text: 'X' },
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'go'))
    await host.idle()
    const irisSecond = provider.requests.filter((r) => systemText(r).includes('You are Iris'))[1]
    expect(lastUserText(irisSecond as CompletionRequest)).toContain('Ana is waiting for your answer')
    expect(env.messages.filter((m) => m.payload?.type === 'bot_message_sent')).toHaveLength(1)
    expect(texts(env, dm).at(-1)).toEqual(['Ana', 'ok'])
  })

  it('rejects unknown bots and messages to itself', async () => {
    const { env, host, provider } = await setup([ana], {
      ana: (_r, n) =>
        n === 0
          ? {
              toolCalls: [
                { name: 'message_bot', arguments: { bot: 'Zé', message: 'hi' } },
                { name: 'ask_bot', arguments: { bot: 'Ana', message: 'hi' } },
              ],
            }
          : { text: 'ok' },
    })
    const dm = env.findDirectConversation(ana.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'go'))
    await host.idle()
    const tools = (provider.requests[1]?.messages ?? []).filter((m) => m.role === 'tool')
    expect(tools.map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))).toEqual([
      'There is no bot named "Zé" (use list_bots).',
      'You cannot message yourself.',
    ])
  })
})

describe('after_current_work', () => {
  const allUserText = (request: CompletionRequest) =>
    request.messages
      .filter((m) => m.role === 'user' || m.role === 'tool')
      .flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')))
      .join('\n')

  async function irisBusyWithAna(iris2: Scripts['iris']) {
    const setupResult = await setup([ana, iris], {
      ana: (_r, n) =>
        n === 0
          ? {
              toolCalls: [
                {
                  name: 'message_bot',
                  arguments: { bot: 'iris', message: 'Draw the dental landing page.', expects_reply: false },
                },
              ],
            }
          : { text: 'Sent to Iris.' },
      iris: iris2,
    })
    const { env, host, provider } = setupResult
    host.onMessageCreated(env.userMessage(env.findDirectConversation(ana.id)?.id as string, 'delegate it'))
    await until(() => provider.requests.some((r) => allUserText(r).includes('Draw the dental landing page.')))
    return setupResult
  }

  it('shows the other lane in the chat and wakes the chat with the task once it finishes', async () => {
    const { env, host, provider } = await irisBusyWithAna((request) => {
      const text = allUserText(request)
      if (text.includes('what you were waiting for finished')) return { text: 'Redesign done.' }
      if (text.includes('Set aside until')) return { text: 'I will start once the landing is done.' }
      if (text.includes('redesign the parking site'))
        return {
          toolCalls: [
            { name: 'after_current_work', arguments: { task: 'Redesign the parking site (Maringá).' } },
          ],
        }
      return { text: 'Landing ready.', delayMs: 150 }
    })
    const dm = env.findDirectConversation(iris.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'after the current one, redesign the parking site'))
    await host.idle()

    const chatFirst = provider.requests.find((r) => lastUserText(r).includes('redesign the parking site'))
    expect(lastUserText(chatFirst as CompletionRequest)).toContain(
      'Your other work in progress right now, running on its own beside this conversation:\n- a request from Ana (running for 1 min): "Draw the dental landing page."',
    )
    const wake = provider.requests.find((r) => lastUserText(r).includes('what you were waiting for finished'))
    expect(lastUserText(wake as CompletionRequest)).toContain(
      'You are free now: what you were waiting for finished (a request from Ana). Now do what you set aside in ' +
        'this conversation (if you already did it in another conversation, say so in one line instead of ' +
        'redoing it):\n\nRedesign the parking site (Maringá).',
    )
    expect(texts(env, dm)).toEqual([
      ['user', 'after the current one, redesign the parking site'],
      ['Iris', 'I will start once the landing is done.'],
      ['Iris', 'Redesign done.'],
    ])
    const internal = [...env.conversations.values()].find((c) => c.type === 'internal')
    expect(texts(env, internal?.id as string).at(-1)).toEqual(['Iris', 'Landing ready.'])
  })

  it('refuses when nothing else is running and drops what was set aside when the bot is stopped', async () => {
    const { env, host, provider } = await setup([iris], {
      iris: (_r, n) =>
        n === 0
          ? { toolCalls: [{ name: 'after_current_work', arguments: { task: 'Later.' } }] }
          : { text: 'Doing it now.' },
    })
    const dm = env.findDirectConversation(iris.id)?.id as string
    host.onMessageCreated(env.userMessage(dm, 'after the current one, do this'))
    await host.idle()
    expect(lastUserText(provider.requests[1] as CompletionRequest)).toContain(
      'Not set aside: nothing else of yours is running',
    )

    let set = false
    const busy = await irisBusyWithAna((request) => {
      const text = allUserText(request)
      if (text.includes('what you were waiting for finished')) return { text: 'Woke up.' }
      if (text.includes('Set aside until')) return { text: 'Later, then.' }
      if (text.includes('do this later')) {
        set = true
        return { toolCalls: [{ name: 'after_current_work', arguments: { task: 'The later thing.' } }] }
      }
      return { text: 'Landing ready.', delayMs: 200 }
    })
    const irisDm = busy.env.findDirectConversation(iris.id)?.id as string
    busy.host.onMessageCreated(busy.env.userMessage(irisDm, 'do this later'))
    await until(() => set && texts(busy.env, irisDm).some(([, t]) => t === 'Later, then.'))
    busy.host.control(iris.id, 'stop')
    await busy.host.idle()
    expect(
      busy.provider.requests.some((r) => allUserText(r).includes('what you were waiting for finished')),
    ).toBe(false)
  })
})

async function until(check: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
