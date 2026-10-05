import type { ChatMessage, CompletionRequest } from '@milibot/agent/llm'
import type { FakeStep } from '@milibot/agent/testing'
import type { Message } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { Db } from '../../../src/db/sqlite'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

const dir = useTempDir('bot-messaging')
afterEach(stopRuntimes)

function textOf(message: ChatMessage | undefined): string {
  return (message?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

function lastInput(request: CompletionRequest) {
  const messages = request.messages
  const index = messages.findLastIndex((m) => m.role === 'user')
  return {
    text: textOf(messages[index]),
    tools: messages.slice(index + 1).filter((m) => m.role === 'tool').length,
    system: textOf(messages[0]),
  }
}

type BotScript = (input: ReturnType<typeof lastInput>) => FakeStep

/** One fake provider for every bot, dispatched on "You are <Name>"; tool-less side calls get a greeting. */
function byBot(scripts: Record<string, BotScript>) {
  return (request: CompletionRequest): FakeStep => {
    if (request.tools.length === 0) return { text: 'Hi!' }
    const input = lastInput(request)
    const name = /You are ([^,( ]+)/.exec(input.system)?.[1] ?? '?'
    return scripts[name]?.(input) ?? { text: `${name} ok` }
  }
}

let h: RuntimeHarness

const boot = async (scripts: Record<string, BotScript>, db?: Db) => {
  h = await bootRuntime({
    dir: dir(),
    script: byBot(scripts),
    host: { compaction: false },
    ...(db ? { db } : {}),
  })
}
const messagesOf = (conversationId: string): Message[] =>
  h.store.messages.list(conversationId, { limit: 200 }).messages
const textsBy = (conversationId: string, botId: string) =>
  messagesOf(conversationId)
    .filter((m) => m.authorBotId === botId && m.kind === 'text')
    .map((m) => m.content)
const turnsOf = (name: string, match: string) =>
  h.provider.requests
    .map(lastInput)
    .filter((i) => i.system.includes(`You are ${name}`) && i.tools === 0 && i.text.includes(match)).length

/**
 * Marco set aside Theo's request in their private conversation and the runtime restarted, so neither bot is
 * in the middle of an exchange: Marco is woken there with it while Theo is stopped.
 */
async function wokenAfterRestart(scripts: Record<string, BotScript>) {
  await boot(scripts)
  const ids: Record<string, string> = {}
  for (const name of ['Marco', 'Theo']) {
    const { bot, conversation } = await h.call<{ bot: { id: string }; conversation: { id: string } }>(
      'createBot',
      {},
      { name, label: name },
    )
    ids[name] = bot.id
    ids[`${name}:dm`] = conversation.id
  }
  await h.host.idle()
  const internal = h.store.conversations.internal(ids.Theo as string, ids.Marco as string).conversation.id
  const db = h.db
  await h.stop()
  const now = Date.now()
  db.prepare(
    `INSERT INTO set_aside_requests (id, bot_id, conversation_id, task, waiting_on, created_at, updated_at)
     VALUES ('sar_1', ?, ?, 'QA of PR #24', '["a request from Theo"]', ?, ?)`,
  ).run(ids.Marco, internal, now, now)
  await boot(scripts, db)
  return { ids, internal }
}

describe('a bot writing to a stopped bot in their private conversation', () => {
  it('wakes it there and brings its answer back to the sender in that conversation', async () => {
    const { ids, internal } = await wokenAfterRestart({
      Marco: ({ text }) => {
        if (text.includes('You are free now')) return { text: 'QA of PR #24 passed.' }
        if (text.includes('Theo replied')) return { text: 'Noted.' }
        return { text: 'Marco ok' }
      },
      Theo: ({ text }) => ({
        text: text.includes('QA of PR #24 passed.') ? 'Thanks, merging #24.' : 'Theo ok',
      }),
    })
    await until(() => turnsOf('Marco', 'You are free now') > 0)
    await h.host.idle()

    expect(textsBy(internal, ids.Marco as string)).toEqual(['QA of PR #24 passed.', 'Noted.'])
    expect(textsBy(internal, ids.Theo as string)).toEqual(['Thanks, merging #24.'])
    const reply = h.provider.requests
      .map(lastInput)
      .find((i) => i.system.includes('You are Marco') && i.text.includes('Theo replied'))
    expect(reply?.text).toContain('Thanks, merging #24.')
    // Theo's chat with the user gets neither the message nor the answer, and the exchange ends there.
    expect(textsBy(ids['Theo:dm'] as string, ids.Theo as string)).toEqual(['Hi!'])
    expect(messagesOf(ids['Theo:dm'] as string).map((m) => m.content)).not.toContainEqual(
      expect.stringContaining('PR #24'),
    )
    expect(turnsOf('Theo', 'PR #24')).toBe(1)
  })

  it('keeps what the sender writes after the answer to a message_bot sent from there in that conversation', async () => {
    const { ids, internal } = await wokenAfterRestart({
      Marco: ({ text, tools }) => {
        if (text.includes('You are free now') && tools === 0)
          return {
            toolCalls: [{ name: 'message_bot', arguments: { bot: 'Theo', message: 'Can I merge #24?' } }],
          }
        if (text.includes('Theo replied')) return { text: 'Merging #24 then.' }
        return { text: 'Asked Theo.' }
      },
      Theo: ({ text }) => ({ text: text.includes('Can I merge #24?') ? 'Yes, go ahead.' : 'Theo ok' }),
    })
    await until(() => turnsOf('Marco', 'You are free now') > 0)
    await h.host.idle()

    expect(textsBy(internal, ids.Marco as string)).toEqual([
      'Can I merge #24?',
      'Asked Theo.',
      'Merging #24 then.',
    ])
    expect(textsBy(internal, ids.Theo as string)).toEqual(['Yes, go ahead.'])
    expect(textsBy(ids['Theo:dm'] as string, ids.Theo as string)).toEqual(['Hi!'])
    expect(turnsOf('Theo', '#24')).toBe(1)
  })
})
