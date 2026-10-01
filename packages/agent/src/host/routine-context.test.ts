import { describe, expect, it } from 'vitest'

import type { TurnFinishedInfo } from '../environment'
import { FakeProvider } from '../llm/fake'
import type { ChatMessage } from '../llm/messages'
import { makeBot, TestEnv } from '../test-support/env'
import { DefaultAgentHost } from './agent-host'

const INSTRUCTIONS =
  '[Milibot] Routine "Report" (every day at 08:00) ran at 2026-09-26 08:00: its schedule started it.\n\nRoutine instructions:\nClose the daily report and list the open items.'

function textOf(message: ChatMessage): string {
  return message.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

function setup(script: string[]) {
  const provider = new FakeProvider({ script: script.map((text) => ({ text })) })
  const env = new TestEnv(provider)
  const finished: TurnFinishedInfo[] = []
  env.turnFinished = (info) => finished.push(info)
  const bot = makeBot()
  const conversation = env.addBot(bot)
  return { provider, env, bot, conversation, finished }
}

describe('routine runs in the context (API providers)', () => {
  it('sends the run card as the user instruction of the routine turn', async () => {
    const { provider, env, bot, conversation, finished } = setup(['Report closed. Open items: 2.'])
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    env.routineRun(conversation.id, bot.id, INSTRUCTIONS)
    host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'routine',
      routineId: 'rtn_1',
    })
    await host.idle(bot.id)

    const messages = provider.requests[0]?.messages ?? []
    const last = messages.at(-1) as ChatMessage
    expect(last.role).toBe('user')
    expect(textOf(last)).toContain('Routine instructions:\nClose the daily report and list the open items.')
    expect(finished).toEqual([
      {
        botId: bot.id,
        conversationId: conversation.id,
        turnId: expect.any(String),
        trigger: 'routine',
        routineId: 'rtn_1',
        outcome: 'done',
        reply: 'Report closed. Open items: 2.',
      },
    ])
    await host.stop()
  })

  it('keeps the instructions in the history of later turns', async () => {
    const { provider, env, bot, conversation } = setup(['Report closed.', 'Yes, every day at 8am.'])
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    env.routineRun(conversation.id, bot.id, INSTRUCTIONS)
    host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'routine',
      routineId: 'rtn_1',
    })
    await host.idle(bot.id)
    host.onMessageCreated(env.userMessage(conversation.id, 'will you do this tomorrow too?'))
    await host.idle(bot.id)

    const later = (provider.requests[1]?.messages ?? []).filter((m) => m.role !== 'system')
    expect(later.map((m) => [m.role, textOf(m).split('\n').at(-1)])).toEqual([
      ['user', 'Close the daily report and list the open items.'],
      ['assistant', 'Report closed.'],
      ['user', 'will you do this tomorrow too?'],
    ])
    await host.stop()
  })

  it("does not show another bot's routine run", async () => {
    const { provider, env, bot, conversation } = setup(['hi'])
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    env.routineRun(conversation.id, 'bot_other', INSTRUCTIONS)
    host.onMessageCreated(env.userMessage(conversation.id, 'hello'))
    await host.idle(bot.id)
    const texts = (provider.requests[0]?.messages ?? []).map(textOf).join('\n')
    expect(texts).not.toContain('Routine instructions')
    await host.stop()
  })

  it('repeats the instructions when the bot answered something else after the card', async () => {
    const { provider, env, bot, conversation } = setup(['Done.'])
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    env.userMessage(conversation.id, 'good morning')
    env.routineRun(conversation.id, bot.id, INSTRUCTIONS)
    env.appendMessage({
      conversationId: conversation.id,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'text',
      content: 'Good morning!',
      payload: { type: 'text', streaming: false, turnId: 't0' },
    })
    host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'routine',
      routineId: 'rtn_1',
    })
    await host.idle(bot.id)
    const last = provider.requests[0]?.messages.at(-1) as ChatMessage
    expect(last.role).toBe('user')
    expect(textOf(last)).toContain('Routine instructions:')
    await host.stop()
  })
})
