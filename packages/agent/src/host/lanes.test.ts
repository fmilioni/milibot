import { describe, expect, it } from 'vitest'

import type { ToolExecContext } from '../environment'
import { FakeProvider, type FakeStep } from '../llm/fake'
import type { ChatMessage } from '../llm/messages'
import type { CompletionRequest } from '../llm/provider'
import { EMPTY_SESSION_REPLY_NOTE, USER_WROTE_MEANWHILE_NOTE } from '../prompts/notes'
import { makeBot, TestEnv } from '../test-support/env'
import { type AgentHostOptions, DefaultAgentHost } from './agent-host'
import { internalLaneKey, laneInfo, sessionLaneKey, subagentLaneKey } from './lanes'

const SESSION = 'wses_01TESTSESSION'

/** Last user text of a request and whether a tool already answered after it. */
function lastInput(request: CompletionRequest): { text: string; afterTool: boolean } {
  const messages = request.messages as ChatMessage[]
  const index = messages.findLastIndex((m) => m.role === 'user')
  const text = (messages[index]?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
  return { text, afterTool: messages.slice(index + 1).some((m) => m.role === 'tool') }
}

/** Replies by input: `tool:<name>` calls that tool once, then answers `done <input>`. */
function script(request: CompletionRequest): FakeStep {
  const { text, afterTool } = lastInput(request)
  const tool = /tool:(\w+)/.exec(text)?.[1]
  if (tool && !afterTool) return { toolCalls: [{ name: tool, arguments: { action: 'screenshot' } }] }
  return { text: `done ${text.split('\n').at(-1)}` }
}

interface Gate {
  release(): void
  started: boolean
}

/** `hooks.onInput` sees the last user text of each model request before it is answered. */
async function setup(hooks: { onInput?: (text: string) => void } = {}, options: AgentHostOptions = {}) {
  const provider = new FakeProvider({
    script: (request) => {
      hooks.onInput?.(lastInput(request).text)
      return script(request)
    },
  })
  const env = new TestEnv(provider)
  const bot = makeBot()
  const chat = env.addBot(bot)
  const session = env.addBot(bot)
  env.sessions.set(session.id, SESSION)
  const gates = new Map<string, Gate>()
  /** Tool calls in `conversationId` block (without releasing their slot) until the gate opens. */
  const gate = (conversationId: string): Gate => {
    const g: Gate = { release: () => undefined, started: false }
    gates.set(conversationId, g)
    return g
  }
  env.toolHandler = async (ctx: ToolExecContext, call) => {
    const g = ctx.conversationId ? gates.get(ctx.conversationId) : undefined
    if (g && (call.name === 'bash' || call.name === 'computer')) {
      g.started = true
      await new Promise<void>((resolve, reject) => {
        g.release = resolve
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    return { content: [{ type: 'text', text: `ran ${call.name}` }] }
  }
  const host = new DefaultAgentHost({ deltaFlushMs: 1, ...options })
  await host.start(env)
  const say = (conversationId: string, text: string) =>
    host.onMessageCreated(env.userMessage(conversationId, text))
  const replies = (conversationId: string) =>
    env.messages
      .filter((m) => m.conversationId === conversationId && m.kind === 'text' && m.authorType === 'bot')
      .map((m) => m.content)
  return { env, bot, chat, session, host, gate, say, replies, provider }
}

const until = async (check: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('lane keys', () => {
  it('parses main, session and subagent lanes', () => {
    expect(laneInfo('bot_1')).toMatchObject({ kind: 'main', botId: 'bot_1', sessionId: null })
    expect(laneInfo(sessionLaneKey('bot_1', 'wses_2'))).toMatchObject({
      kind: 'session',
      botId: 'bot_1',
      sessionId: 'wses_2',
      parentKey: 'bot_1',
    })
    expect(laneInfo(subagentLaneKey('bot_1', 'wses_2', 3))).toMatchObject({
      kind: 'subagent',
      sessionId: 'wses_2',
      parentKey: 'bot_1:wses_2',
    })
    expect(laneInfo(subagentLaneKey('bot_1', null, 4))).toMatchObject({
      kind: 'subagent',
      botId: 'bot_1',
      sessionId: null,
      parentKey: 'bot_1',
    })
  })
})

describe('internal lane', () => {
  it('parses its key', () => {
    expect(laneInfo(internalLaneKey('bot_1'))).toMatchObject({
      kind: 'internal',
      botId: 'bot_1',
      sessionId: null,
    })
  })

  it('runs requests from other bots in the internal lane, so the user is answered meanwhile', async () => {
    const { env, bot, chat, host, gate, say, replies } = await setup()
    const peer = makeBot({ name: 'Paula', slug: 'paula' })
    env.addBot(peer)
    const internal = env.internalConversation(peer.id, bot.id)
    const busy = gate(internal.id)
    env.appendMessage({
      conversationId: internal.id,
      authorType: 'bot',
      authorBotId: peer.id,
      kind: 'text',
      content: 'tool:bash',
      payload: { type: 'text', streaming: false, turnId: null },
      turnId: null,
    })
    host.enqueueTurn({ botId: bot.id, conversationId: internal.id, trigger: 'bot_message' })
    await until(() => busy.started)
    say(chat.id, 'did they edit anything yet?')
    await until(() => replies(chat.id).length === 1)
    expect(replies(chat.id)).toEqual(['done did they edit anything yet?'])
    busy.release()
    await host.idle(bot.id)
  })
})

describe('messages sent while a turn works', () => {
  const texts = (request: CompletionRequest | undefined) =>
    ((request?.messages ?? []) as ChatMessage[]).flatMap((m) =>
      m.role === 'user' ? m.content.map((p) => (p.type === 'text' ? p.text : '')) : [],
    )

  it('join the chat turn at its next step, without a turn of their own', async () => {
    const { env, bot, chat, host, gate, say, replies, provider } = await setup()
    const busy = gate(chat.id)
    say(chat.id, 'tool:computer')
    await until(() => busy.started)
    say(chat.id, 'make every screen dark')
    busy.release()
    await host.idle(bot.id)

    expect(provider.requests).toHaveLength(2)
    const joined = texts(provider.requests[1])
    expect(joined).toContain(USER_WROTE_MEANWHILE_NOTE)
    expect(joined).toContain('make every screen dark')
    expect(replies(chat.id)).toEqual(['done make every screen dark'])
    const order = env.messages.filter((m) => m.conversationId === chat.id).map((m) => m.content)
    expect(order.indexOf('make every screen dark')).toBeLessThan(order.indexOf('done make every screen dark'))
    expect(env.statuses.at(-1)?.status).toBe('idle')
  })

  it('join before the turn ends when they arrive while the model writes its reply', async () => {
    const hooks: { onInput?: (text: string) => void } = {}
    const { bot, chat, host, say, replies, provider } = await setup(hooks)
    hooks.onInput = (text) => {
      if (text.endsWith('\nfirst') || text === 'first') say(chat.id, 'second')
    }
    say(chat.id, 'first')
    await host.idle(bot.id)
    expect(provider.requests).toHaveLength(2)
    expect(replies(chat.id)).toEqual(['done first', 'done second'])
  })

  it('join a busy work session at its next step', async () => {
    const { bot, session, host, gate, say, replies, provider } = await setup()
    const busy = gate(session.id)
    say(session.id, 'tool:computer')
    await until(() => busy.started)
    say(session.id, 'target the tablet layout too')
    busy.release()
    await host.idle(bot.id)
    expect(provider.requests).toHaveLength(2)
    expect(texts(provider.requests[1])).toContain('target the tablet layout too')
    expect(replies(session.id)).toEqual(['done target the tablet layout too'])
  })

  it('in another conversation wait for the lane to be free', async () => {
    const { env, bot, chat, host, gate, say, replies } = await setup()
    const busy = gate(chat.id)
    say(chat.id, 'tool:bash')
    await until(() => busy.started)
    const other = env.addBot(bot)
    say(other.id, 'hi')
    await new Promise((r) => setTimeout(r, 30))
    expect(replies(other.id)).toEqual([])
    busy.release()
    await host.idle(bot.id)
    expect(replies(chat.id)).toEqual(['done tool:bash'])
    expect(replies(other.id)).toEqual(['done hi'])
  })
})

describe('bot lanes', () => {
  it("runs a work session's turn next to the chat: the chat answers while the session works", async () => {
    const { env, bot, chat, session, host, gate, say, replies } = await setup()
    const g = gate(session.id)
    say(session.id, 'tool:bash')
    await until(() => g.started)
    const sessionStatus = env.statuses.at(-1)
    expect(sessionStatus).toMatchObject({ status: 'working', detail: 'bash', sessionId: SESSION })

    say(chat.id, 'hi')
    await until(() => replies(chat.id).length === 1)
    expect(replies(chat.id)).toEqual(['done hi'])
    expect(replies(session.id)).toEqual([])
    // With the chat lane idle again, the bot shows the session's work.
    expect(env.statuses.at(-1)).toMatchObject({ status: 'working', sessionId: SESSION })
    expect(host.screenState(bot.id).busy).toBe(true)

    g.release()
    await host.idle(bot.id)
    expect(replies(session.id)).toEqual(['done tool:bash'])
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'idle' })
  })

  it('sends what reaches an ended session to the conversation it started from', async () => {
    const { env, bot, chat, session, host, replies, provider } = await setup()
    env.endedSessions.set(SESSION, { originConversationId: chat.id, title: 'Avatars' })
    host.enqueueTurn({ botId: bot.id, conversationId: session.id, trigger: 'bot_reply', note: 'Lia: done' })
    await host.idle(bot.id)
    expect(replies(session.id)).toEqual([])
    expect(replies(chat.id)).toHaveLength(1)
    expect(replies(chat.id)[0]).toContain('Lia: done')
    const note = provider.requests
      .flatMap((r) => r.messages)
      .flatMap((m) => m.content)
      .some((p) => p.type === 'text' && p.text.includes('"Avatars", which already ended'))
    expect(note).toBe(true)
  })

  it('redirects a turn queued in a session lane when the session ends before it runs', async () => {
    const { env, bot, chat, session, host, gate, say, replies } = await setup()
    const running = gate(session.id)
    say(session.id, 'tool:bash')
    await until(() => running.started)
    host.enqueueTurn({ botId: bot.id, conversationId: session.id, trigger: 'bot_reply', note: 'Diego: ok' })
    env.endedSessions.set(SESSION, { originConversationId: chat.id, title: 'Avatars' })
    running.release()
    await host.idle(bot.id)
    expect(replies(session.id)).toEqual(['done tool:bash'])
    expect(replies(chat.id)).toHaveLength(1)
  })

  it('counts every lane against agents.max_parallel', async () => {
    const { env, bot, chat, session, host, gate, say, replies } = await setup()
    env.settings['agents.max_parallel'] = 1
    const g = gate(session.id)
    say(session.id, 'tool:bash')
    await until(() => g.started)
    say(chat.id, 'hi')
    await new Promise((r) => setTimeout(r, 30))
    expect(replies(chat.id)).toEqual([])
    g.release()
    await host.idle(bot.id)
    expect(replies(chat.id)).toEqual(['done hi'])
  })

  it('keeps a slot for the chat: agents.max_parallel_sessions caps the session lanes', async () => {
    const { env, bot, chat, session, host, gate, say, replies } = await setup()
    env.settings['agents.max_parallel'] = 3
    env.settings['agents.max_parallel_sessions'] = 1
    const second = env.addBot(bot)
    env.sessions.set(second.id, 'wses_01SECOND')
    const first = gate(session.id)
    say(session.id, 'tool:bash')
    await until(() => first.started)
    say(second.id, 'second session')
    say(chat.id, 'hi')
    await until(() => replies(chat.id).length === 1)
    expect(replies(second.id)).toEqual([])
    first.release()
    await host.idle(bot.id)
    expect(replies(second.id)).toEqual(['done second session'])
  })

  it('stops only the lanes asked for: the chat, a session or everything', async () => {
    const { env, bot, chat, session, host, gate, say, replies } = await setup()
    const inChat = gate(chat.id)
    const inSession = gate(session.id)
    say(chat.id, 'tool:bash')
    say(session.id, 'tool:bash')
    await until(() => inChat.started && inSession.started)

    host.control(bot.id, 'stop', { scope: 'chat' })
    await until(() => env.messages.some((m) => m.payload?.type === 'system' && m.conversationId === chat.id))
    await new Promise((r) => setTimeout(r, 20))
    expect(host.screenState(bot.id).busy).toBe(true)
    const stoppedIn = env.messages
      .filter((m) => m.payload?.type === 'system' && m.payload.event === 'turn_stopped')
      .map((m) => m.conversationId)
    expect(stoppedIn).toEqual([chat.id])

    host.control(bot.id, 'stop', { sessionId: SESSION })
    await host.idle(bot.id)
    expect(replies(session.id)).toEqual([])
    expect(host.screenState(bot.id).busy).toBe(false)

    const again = [gate(chat.id), gate(session.id)]
    say(chat.id, 'tool:bash')
    say(session.id, 'tool:bash')
    await until(() => again.every((g) => g.started))
    host.control(bot.id, 'stop')
    await host.idle(bot.id)
    expect(replies(chat.id)).toEqual([])
    expect(replies(session.id)).toEqual([])
  })

  it('pausing the bot holds every lane until it is resumed', async () => {
    const { env, bot, chat, session, host, say, replies } = await setup()
    host.control(bot.id, 'pause')
    say(chat.id, 'hi')
    say(session.id, 'in the session')
    await host.idle(bot.id)
    expect(env.llmCalls).toHaveLength(0)
    expect(env.statuses.at(-1)?.status).toBe('paused')
    host.control(bot.id, 'resume')
    await host.idle(bot.id)
    expect(replies(chat.id)).toEqual(['done hi'])
    expect(replies(session.id)).toEqual(['done in the session'])
  })

  it("lends the bot's screen to one lane at a time", async () => {
    const { env, bot, chat, session, host, gate, say, replies } = await setup({}, { screenWaitSeconds: 0.05 })
    // The session takes the screen with its first computer call and keeps it until its turn ends.
    const holder = gate(session.id)
    say(session.id, 'tool:computer')
    await until(() => holder.started)

    say(chat.id, 'tool:computer')
    await until(() => replies(chat.id).length === 1)
    const refused = [...env.toolCalls.values()].find((t) => t.conversationId === chat.id)
    expect(refused).toMatchObject({ status: 'error' })
    expect(JSON.stringify(refused?.result)).toContain('in use by another task')
    holder.release()
    await host.idle(bot.id)
  })

  it('makes another lane wait for the screen until the holding turn ends', async () => {
    const { env, bot, chat, session, host, gate, say } = await setup()
    const holder = gate(session.id)
    say(session.id, 'tool:computer')
    await until(() => holder.started)

    say(chat.id, 'again tool:computer')
    await until(() => env.statuses.some((s) => s.detail === 'screenshot' && !s.sessionId))
    const before = env.toolLog.length
    holder.release()
    await host.idle(bot.id)
    expect(env.toolLog.length).toBe(before + 1)
    const last = [...env.toolCalls.values()].at(-1)
    expect(last).toMatchObject({ conversationId: chat.id, status: 'ok' })
  })

  it('routes tool calls of a lane (Claude Code over MCP) to that lane’s turn', async () => {
    const { env, bot, session, host, gate, say } = await setup()
    const g = gate(session.id)
    say(session.id, 'tool:bash')
    await until(() => g.started)
    const result = await host.runTool(
      bot.id,
      null,
      { id: 'mcp_1', name: 'list_bots', arguments: {} },
      sessionLaneKey(bot.id, SESSION),
    )
    expect(result.isError).toBeFalsy()
    const call = [...env.toolCalls.values()].find((t) => t.toolName === 'list_bots')
    expect(call?.conversationId).toBe(session.id)
    g.release()
    await host.idle(bot.id)
  })
})

describe('empty replies', () => {
  async function run(steps: FakeStep[], where: 'session' | 'chat') {
    const provider = new FakeProvider({ script: steps, fallback: { text: 'unexpected call' } })
    const env = new TestEnv(provider)
    const bot = makeBot()
    const chat = env.addBot(bot)
    const session = env.addBot(bot)
    env.sessions.set(session.id, SESSION)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    const conversationId = where === 'session' ? session.id : chat.id
    host.onMessageCreated(env.userMessage(conversationId, 'go on'))
    await until(() => provider.requests.length >= 1)
    await host.idle(bot.id)
    const replies = env.messages
      .filter((m) => m.conversationId === conversationId && m.authorType === 'bot' && m.kind === 'text')
      .map((m) => m.content)
    return { env, provider, replies }
  }

  const nudged = (request: CompletionRequest | undefined) => {
    const last = request?.messages.at(-1)
    return (
      last?.role === 'user' &&
      last.content.some((p) => p.type === 'text' && p.text === EMPTY_SESSION_REPLY_NOTE)
    )
  }

  it('asks a session lane again once when the model answers with nothing', async () => {
    const { env, provider, replies } = await run([{}, { text: 'step done' }], 'session')
    expect(provider.requests).toHaveLength(2)
    expect(nudged(provider.requests[1])).toBe(true)
    expect(provider.requests[1]?.messages.at(-2)?.role).toBe('user')
    expect(env.llmCalls).toHaveLength(2)
    expect(replies).toEqual(['step done'])
    expect(env.messages.some((m) => m.content.includes(EMPTY_SESSION_REPLY_NOTE))).toBe(false)
  })

  it('ends the session turn when the second reply is empty too', async () => {
    const { provider } = await run([{ text: '   ' }, {}], 'session')
    expect(provider.requests).toHaveLength(2)
  })

  it('nudges only once per turn, even after work in between', async () => {
    const { provider } = await run(
      [{}, { toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }] }, {}],
      'session',
    )
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests.filter(nudged)).toHaveLength(1)
  })

  it('leaves an empty reply in the chat as the end of the turn', async () => {
    const { provider } = await run([{}], 'chat')
    expect(provider.requests).toHaveLength(1)
  })
})
