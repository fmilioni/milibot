import { describe, expect, it } from 'vitest'

import { FakeProvider } from '../llm/fake'
import { makeBot, screenshotTools, TestEnv } from '../test-support/env'
import { DefaultAgentHost } from './agent-host'

const RECORDS = new Set(['turn.start', 'turn.end', 'bot.status', 'lane.status', 'lane.open', 'lane.close'])

async function setup() {
  const provider = new FakeProvider({
    script: [
      { text: 'Looking.', toolCalls: [{ name: 'computer', arguments: { action: 'screenshot' } }] },
      { toolCalls: [{ name: 'bash', arguments: { command: 'cat /secret/token' } }] },
      { text: 'Done.' },
    ],
  })
  const env = new TestEnv(provider)
  env.toolHandler = screenshotTools(env)
  const bot = makeBot()
  const conversation = env.addBot(bot)
  const host = new DefaultAgentHost({ deltaFlushMs: 1 })
  await host.start(env)
  const records = () =>
    env.logs
      .filter((l) => RECORDS.has(l.message))
      .map(({ message, extra }) => {
        const { durationMs, turnId, ...rest } = extra ?? {}
        return { message, ...rest, ...(turnId ? { turnId: 'turn' } : {}) }
      })
  return { env, bot, conversation, host, records }
}

describe('status log', () => {
  it('records a turn and the status changes it makes once, without the activity text', async () => {
    const { env, bot, conversation, host, records } = await setup()
    const base = { botId: bot.id, botName: bot.name }
    host.onMessageCreated(env.userMessage(conversation.id, 'look'))
    await host.idle(bot.id)

    expect(records()).toEqual([
      { message: 'lane.open', ...base, lane: bot.id, kind: 'main' },
      { message: 'lane.status', ...base, lane: bot.id, from: 'idle', to: 'thinking', reason: 'queued' },
      { message: 'bot.status', ...base, lane: bot.id, from: 'idle', to: 'thinking', reason: 'queued' },
      { message: 'turn.start', ...base, lane: bot.id, turnId: 'turn', trigger: 'user_message' },
      {
        message: 'turn.end',
        ...base,
        lane: bot.id,
        turnId: 'turn',
        trigger: 'user_message',
        outcome: 'done',
      },
      { message: 'lane.status', ...base, lane: bot.id, from: 'talking', to: 'idle', reason: 'turn_end' },
      { message: 'bot.status', ...base, lane: bot.id, from: 'talking', to: 'idle', reason: 'turn_end' },
    ])
    const end = env.logs.find((l) => l.message === 'turn.end')
    expect(end?.extra?.durationMs).toEqual(expect.any(Number))
    expect(JSON.stringify(env.logs)).not.toContain('/secret/token')
  })

  it('records pausing and resuming as status changes with their reason', async () => {
    const { env, bot, host, records } = await setup()
    const base = { botId: bot.id, botName: bot.name }
    host.control(bot.id, 'pause')
    host.control(bot.id, 'pause')
    host.control(bot.id, 'resume')
    expect(records().filter((r) => r.message === 'bot.status')).toEqual([
      { message: 'bot.status', ...base, lane: bot.id, from: 'idle', to: 'paused', reason: 'pause' },
      { message: 'bot.status', ...base, lane: bot.id, from: 'paused', to: 'idle', reason: 'refresh' },
    ])
    expect(env.logs.every((l) => l.level === 'info' || !RECORDS.has(l.message))).toBe(true)
  })
})
