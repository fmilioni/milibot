import { type Bot, PREFERENCE_SETTING_KEYS } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { FakeProvider, type FakeStep } from '../llm/fake'
import type { CompletionRequest } from '../llm/provider'
import { makeBot, TestEnv } from '../test-support/env'
import { DefaultAgentHost } from './agent-host'

const ana = makeBot({ name: 'Ana', slug: 'ana', label: 'PM' })
const iris = makeBot({ name: 'Iris', slug: 'iris', label: 'QA', displayNum: 2 })

function systemText(request: CompletionRequest): string {
  const system = request.messages.find((m) => m.role === 'system')
  return system?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
}

function lastUserText(request: CompletionRequest): string {
  const users = request.messages.filter((m) => m.role === 'user' || m.role === 'tool')
  return (users.at(-1)?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

type Script = (request: CompletionRequest, text: string) => FakeStep

const hosts: DefaultAgentHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

/** Ana and Iris on one provider, each answering with its own script. */
function setup(scripts: { ana?: Script; iris?: Script }) {
  const provider = new FakeProvider({
    script: (request) => {
      const script = systemText(request).includes('You are Iris') ? scripts.iris : scripts.ana
      return script?.(request, lastUserText(request)) ?? { text: 'ok' }
    },
  })
  const env = new TestEnv(provider)
  for (const bot of [ana, iris]) env.addBot(bot)
  return { env, provider }
}

async function startHost(env: TestEnv, idleWatchIntervalMs = 60_000) {
  const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false, idleWatchIntervalMs })
  hosts.push(host)
  await host.start(env)
  return host
}

const dmOf = (env: TestEnv, bot: Bot) => env.findDirectConversation(bot.id)?.id as string

async function until(check: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("the bot's state in every conversation", () => {
  it('lists sessions, plans and requests set aside from other conversations', async () => {
    const { env, provider } = setup({})
    const internal = env.internalConversation(ana.id, iris.id)
    env.workStates.set(iris.id, {
      sessions: [{ id: 'wses_1', conversationId: 'cnv_session', title: 'QA of PR #22' }],
      plans: [{ id: 'plan_1', title: 'Release 0.3', status: 'awaiting_approval' }],
    })
    env.setAside.add({
      botId: iris.id,
      conversationId: internal.id,
      task: 'QA of PR #23',
      waitingOn: ['your work session "QA of PR #22"'],
    })
    const host = await startHost(env)
    host.onMessageCreated(env.userMessage(dmOf(env, iris), 'are you busy?'))
    await host.idle()

    expect(lastUserText(provider.requests[0] as CompletionRequest)).toContain(
      [
        'Work sessions still open, with no turn running now (waiting for a reply or an answer, or never finished with session_finish):',
        '- your work session "QA of PR #22"',
        'Plans not finished:',
        '- "Release 0.3" (awaiting approval)',
        'Requests you set aside, to take up when your current work ends (you are woken with each then):',
        '- "QA of PR #23" (in your conversation with Ana, 0 min ago)',
        'When the user or another bot speaks of what you are doing now',
      ].join('\n'),
    )
  })

  it('tells a bot with nothing open that it is free', async () => {
    const { env, provider } = setup({})
    const host = await startHost(env)
    host.onMessageCreated(env.userMessage(dmOf(env, iris), 'hello'))
    await host.idle()
    expect(lastUserText(provider.requests[0] as CompletionRequest)).toContain(
      'No other work of yours is running and no work session is open: you are free. Start what is asked here now',
    )
  })
})

describe('requests set aside', () => {
  it('sets aside a request from another bot while a session is open and wakes the bot once it ends', async () => {
    const session = { id: 'wses_1', conversationId: 'cnv_session', title: 'QA of PR #22' }
    const { env, provider } = setup({
      ana: (_r, text) =>
        text.includes('review PR #23')
          ? {
              toolCalls: [
                {
                  name: 'message_bot',
                  arguments: { bot: 'Iris', message: 'Run the QA of PR #23.', expects_reply: false },
                },
              ],
            }
          : { text: 'Sent.' },
      iris: (_r, text) => {
        if (text.includes('You are free now')) return { text: 'Starting the QA of PR #23.' }
        if (text.includes('Set aside until')) return { text: 'After the QA of #22.' }
        if (text.includes('Run the QA of PR #23.'))
          return { toolCalls: [{ name: 'after_current_work', arguments: { task: 'QA of PR #23' } }] }
        return { text: 'ok' }
      },
    })
    env.workStates.set(iris.id, { sessions: [session], plans: [] })
    const host = await startHost(env, 10)
    host.onMessageCreated(env.userMessage(dmOf(env, ana), 'review PR #23'))
    await until(() => env.setAside.waiting(iris.id).length === 1)
    await host.idle()
    expect(env.setAside.waiting(iris.id)[0]).toMatchObject({
      task: 'QA of PR #23',
      waitingOn: ['your work session "QA of PR #22"'],
    })
    expect(provider.requests.some((r) => lastUserText(r).includes('You are free now'))).toBe(false)

    // The session ends in another conversation, with no turn of this one.
    env.workStates.delete(iris.id)
    await until(() => provider.requests.some((r) => lastUserText(r).includes('You are free now')))
    await host.idle()
    const wake = provider.requests.find((r) => lastUserText(r).includes('You are free now'))
    expect(lastUserText(wake as CompletionRequest)).toContain(
      'You are free now: what you were waiting for finished (your work session "QA of PR #22"). Now do what you set aside in this conversation:\n\nQA of PR #23',
    )
    const internal = env.internalConversation(ana.id, iris.id)
    expect(env.messages.filter((m) => m.conversationId === internal.id).at(-1)?.content).toBe(
      'Starting the QA of PR #23.',
    )
    expect(env.setAside.entries.map((e) => e.status)).toEqual(['woken'])
  })

  it('wakes a free bot with what it set aside before a restart, one request at a time', async () => {
    const order: string[] = []
    const { env } = setup({
      iris: (_r, text) => {
        const task = /\n\n(Task \w+)$/.exec(text)?.[1]
        if (task) order.push(task)
        return { text: `Doing ${task ?? 'nothing'}.` }
      },
    })
    const internal = env.internalConversation(ana.id, iris.id)
    env.setAside.add({ botId: iris.id, conversationId: dmOf(env, iris), task: 'Task one', waitingOn: [] })
    env.setAside.add({ botId: iris.id, conversationId: internal.id, task: 'Task two', waitingOn: [] })
    const host = await startHost(env)
    await until(() => order.length === 2)
    await host.idle()
    expect(order).toEqual(['Task one', 'Task two'])
    expect(env.setAside.waiting()).toEqual([])
  })

  it('starts a request at once when the bot is already free', async () => {
    const { env, provider } = setup({
      iris: (_r, text) =>
        text.includes('Not set aside')
          ? { text: 'Doing it now.' }
          : { toolCalls: [{ name: 'after_current_work', arguments: { task: 'Later.' } }] },
    })
    const host = await startHost(env)
    host.onMessageCreated(env.userMessage(dmOf(env, iris), 'after this, check the build'))
    await host.idle()
    expect(lastUserText(provider.requests[1] as CompletionRequest)).toContain('you are free. Do it now')
    expect(env.setAside.entries).toEqual([])
  })
})

describe('idle watch', () => {
  it('tells the chosen bot once when a bot stays stopped with requests set aside', async () => {
    const { env, provider } = setup({ ana: () => ({ text: 'Iris, pick up PR #23 or drop it.' }) })
    env.settings[PREFERENCE_SETTING_KEYS.idleWatchMinutes] = 30
    env.settings[PREFERENCE_SETTING_KEYS.idleWatchBotId] = ana.id
    env.workStates.set(iris.id, {
      sessions: [{ id: 'wses_1', conversationId: 'cnv_s', title: 'QA of PR #22' }],
      plans: [],
    })
    const internal = env.internalConversation(iris.id, ana.id)
    env.setAside.add({ botId: iris.id, conversationId: internal.id, task: 'QA of PR #23', waitingOn: [] })
    const host = await startHost(env, 10)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(provider.requests).toHaveLength(0)

    env.advance(31 * 60_000)
    await until(() => provider.requests.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await host.idle()
    const asked = (name: string) => provider.requests.filter((r) => systemText(r).includes(`You are ${name}`))
    expect(asked('Ana')).toHaveLength(1)
    const note = lastUserText(asked('Ana')[0] as CompletionRequest)
    expect(note).toContain('Iris has done nothing for 31 min while it has requests set aside for later')
    expect(note).toContain('- "QA of PR #23"')
    expect(note).toContain('Its work sessions still open (no turn running): "QA of PR #22".')
    expect(env.messages.filter((m) => m.conversationId === internal.id).at(-1)?.content).toBe(
      'Iris, pick up PR #23 or drop it.',
    )
    // What Ana wrote there reaches Iris.
    expect(lastUserText(asked('Iris')[0] as CompletionRequest)).toContain(
      'Ana sent a follow-up in your private conversation',
    )
    expect(env.setAside.waiting(iris.id)[0]?.alertedAt).not.toBeNull()
  })

  it('stays quiet when it is off or the bot is working', async () => {
    const { env, provider } = setup({})
    env.settings[PREFERENCE_SETTING_KEYS.idleWatchMinutes] = 0
    env.workStates.set(iris.id, {
      sessions: [{ id: 'wses_1', conversationId: 'cnv_s', title: 'QA' }],
      plans: [],
    })
    env.setAside.add({ botId: iris.id, conversationId: dmOf(env, iris), task: 'Later', waitingOn: [] })
    const host = await startHost(env, 10)
    env.advance(120 * 60_000)
    await new Promise((resolve) => setTimeout(resolve, 40))
    await host.idle()
    expect(provider.requests).toHaveLength(0)
  })
})
