import type { ChatMessage, CompletionRequest } from '@milibot/agent/llm'
import type { FakeStep } from '@milibot/agent/testing'
import type { Message, SetAsideRequest, WorkSession } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { Db } from '../../../src/db/sqlite'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

const dir = useTempDir('set-aside')
afterEach(stopRuntimes)

function textOf(message: ChatMessage | undefined): string {
  return (message?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

/** The latest input of a request and how many tool results followed it. */
function lastInput(request: CompletionRequest) {
  const messages = request.messages
  const index = messages.findLastIndex((m) => m.role === 'user')
  const results = messages.slice(index + 1).filter((m) => m.role === 'tool')
  return {
    text: textOf(messages[index]),
    tools: results.length,
    results: results.map(textOf).join('\n'),
    system: textOf(messages[0]),
    /** Every user message of the request (the chat's notes come apart from the user's text). */
    input: messages
      .filter((m) => m.role === 'user')
      .map(textOf)
      .join('\n'),
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

const delegate =
  (pr: string): BotScript =>
  ({ text, tools }) =>
    text.includes(`send PR ${pr} to Marco`) && tools === 0
      ? {
          toolCalls: [
            {
              name: 'message_bot',
              arguments: { bot: 'Marco', message: `Run the QA of PR ${pr}.`, expects_reply: false },
            },
          ],
        }
      : { text: 'Sent.' }

const startQa = (pr: string): FakeStep => ({
  toolCalls: [{ name: 'session_start', arguments: { title: `QA of PR ${pr}`, goal: `Check PR ${pr}.` } }],
})

/**
 * Marco runs QA in work sessions. In a conversation that last saw him busy with #22, a model with nothing
 * else to go on assumes he still is and only notes #23 for later; told he is free, it starts at once.
 */
function marco(options: { sessionMs?: number; finish?: boolean } = {}): BotScript {
  return ({ text, tools, results, system }) => {
    if (system.includes('# Work session')) {
      if (tools === 0 && options.finish !== false)
        return {
          toolCalls: [{ name: 'session_finish', arguments: { summary: 'QA passed.', status: 'done' } }],
          delayMs: options.sessionMs ?? 0,
        }
      return { text: options.finish === false ? 'Waiting for the build.' : 'Closed.' }
    }
    if (tools > 0) return { text: results.includes('Set aside until') ? 'After the QA of #22.' : 'Started.' }
    // Retrieved snippets of other conversations come first in the input: match on its end.
    if (text.includes('You are free now')) return startQa('#23')
    if (text.endsWith('Run the QA of PR #23.')) {
      if (text.includes('you are free. Start')) return startQa('#23')
      if (text.includes('call after_current_work'))
        return { toolCalls: [{ name: 'after_current_work', arguments: { task: 'QA of PR #23' } }] }
      return { text: 'Noted: PR #23 goes in after the QA of #22 closes.' }
    }
    if (text.endsWith('Run the QA of PR #22.')) return startQa('#22')
    if (text.includes('Your work session')) return { text: 'QA of #22 passed.' }
    return { text: 'ok' }
  }
}

let h: RuntimeHarness

let clock = Date.now()

async function boot(script: Record<string, BotScript>, db?: Db, idleWatchIntervalMs?: number) {
  clock = Date.now()
  h = await bootRuntime({
    dir: dir(),
    script: byBot(script),
    host: { compaction: false, ...(idleWatchIntervalMs ? { idleWatchIntervalMs } : {}) },
    runtime: { now: () => clock },
    ...(db ? { db } : {}),
  })
  return h
}

async function createBots(...names: string[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {}
  for (const name of names) {
    const { bot, conversation } = await h.call<{ bot: { id: string }; conversation: { id: string } }>(
      'createBot',
      {},
      { name, label: name },
    )
    ids[name] = bot.id
    ids[`${name}:dm`] = conversation.id
  }
  await h.host.idle()
  return ids
}

const sessions = () => h.call<WorkSession[]>('listWorkSessions', {}, undefined, {})
const sessionTitled = async (title: string) => (await sessions()).find((s) => s.title === title)
const messagesOf = (conversationId: string): Message[] =>
  h.store.messages.list(conversationId, { limit: 200 }).messages
const internalOf = (a: string, b: string) => h.store.conversations.internal(a, b).conversation.id
/** What Marco wrote and did in a conversation, in order. */
const marcoLines = (conversationId: string, marcoId: string) =>
  messagesOf(conversationId)
    .filter((m) => m.authorBotId === marcoId)
    .map((m) => m.content)

describe('a bot that finished its work in another conversation', () => {
  it('starts a new request in the same turn instead of putting it off', async () => {
    await boot({ Nina: delegate('#22'), Theo: delegate('#23'), Marco: marco() })
    const ids = await createBots('Marco', 'Nina', 'Theo')

    // Conversation A (Nina → Marco): Marco opens the QA session of #22, which ends.
    await h.call(
      'postMessage',
      { conversationId: ids['Nina:dm'] as string },
      { content: 'send PR #22 to Marco' },
    )
    await until(async () => (await sessionTitled('QA of PR #22'))?.status === 'done')
    await h.host.idle()

    // Conversation B (Theo → Marco): the request for #23.
    await h.call(
      'postMessage',
      { conversationId: ids['Theo:dm'] as string },
      { content: 'send PR #23 to Marco' },
    )
    await h.host.idle()

    const b = internalOf(ids.Theo as string, ids.Marco as string)
    expect(await sessionTitled('QA of PR #23')).toBeDefined()
    expect(marcoLines(b, ids.Marco as string)).toEqual(['started work session: QA of PR #23', 'Started.'])
    expect(await h.call<SetAsideRequest[]>('listSetAsideRequests', {}, undefined, {})).toEqual([])
  })
})

describe('requests set aside', () => {
  it('wakes the bot with the request once a session opened in another conversation ends', async () => {
    await boot({ Nina: delegate('#22'), Theo: delegate('#23'), Marco: marco({ sessionMs: 400 }) })
    const ids = await createBots('Marco', 'Nina', 'Theo')
    await h.call(
      'postMessage',
      { conversationId: ids['Nina:dm'] as string },
      { content: 'send PR #22 to Marco' },
    )
    await until(async () => (await sessionTitled('QA of PR #22'))?.status === 'running')

    await h.call(
      'postMessage',
      { conversationId: ids['Theo:dm'] as string },
      { content: 'send PR #23 to Marco' },
    )
    await until(
      async () => (await h.call<SetAsideRequest[]>('listSetAsideRequests', {}, undefined, {})).length > 0,
    )
    const [waiting] = await h.call<SetAsideRequest[]>('listSetAsideRequests', {}, undefined, {
      botId: ids.Marco,
    })
    expect(waiting).toMatchObject({ task: 'QA of PR #23', waitingOn: ['your work session "QA of PR #22"'] })
    expect(await sessionTitled('QA of PR #23')).toBeUndefined()

    await until(async () => Boolean(await sessionTitled('QA of PR #23')))
    await h.host.idle()
    const b = internalOf(ids.Theo as string, ids.Marco as string)
    expect(marcoLines(b, ids.Marco as string)).toEqual([
      'set aside for later: QA of PR #23',
      'After the QA of #22.',
      'started work session: QA of PR #23',
      'Started.',
    ])
    expect((await sessionTitled('QA of PR #22'))?.status).toBe('done')
    expect(h.db.prepare("SELECT status FROM set_aside_requests WHERE task = 'QA of PR #23'").get()).toEqual({
      status: 'woken',
    })
    expect(h.events.some((e) => e.type === 'set_aside.changed' && e.payload.botId === ids.Marco)).toBe(true)
  })

  it('lists what waits on an open session and lets the user drop it', async () => {
    await boot({ Nina: delegate('#22'), Theo: delegate('#23'), Marco: marco({ finish: false }) })
    const ids = await createBots('Marco', 'Nina', 'Theo')
    await h.call(
      'postMessage',
      { conversationId: ids['Nina:dm'] as string },
      { content: 'send PR #22 to Marco' },
    )
    await until(async () => (await sessionTitled('QA of PR #22'))?.status === 'idle')
    await h.host.idle()
    await h.call(
      'postMessage',
      { conversationId: ids['Theo:dm'] as string },
      { content: 'send PR #23 to Marco' },
    )
    await h.host.idle()

    const [waiting] = await h.call<SetAsideRequest[]>('listSetAsideRequests', {}, undefined, {})
    expect(waiting).toMatchObject({ botId: ids.Marco, status: 'waiting', task: 'QA of PR #23' })
    await h.call('dropSetAsideRequest', { requestId: waiting?.id as string })
    expect(await h.call<SetAsideRequest[]>('listSetAsideRequests', {}, undefined, {})).toEqual([])
    await expect(h.call('dropSetAsideRequest', { requestId: waiting?.id as string })).rejects.toThrow()
  })

  it('keeps them across a restart and wakes a free bot with them', async () => {
    await boot({ Marco: ({ text }) => ({ text: text.includes('You are free now') ? 'On it.' : 'ok' }) })
    const ids = await createBots('Marco')
    const db = h.db
    await h.stop()
    const now = Date.now()
    db.prepare(
      `INSERT INTO set_aside_requests (id, bot_id, conversation_id, task, waiting_on, created_at, updated_at)
       VALUES ('sar_1', ?, ?, 'QA of PR #24', '["a request from Theo"]', ?, ?)`,
    ).run(ids.Marco, ids['Marco:dm'], now, now)

    await boot({ Marco: ({ text }) => ({ text: text.includes('You are free now') ? 'On it.' : 'ok' }) }, db)
    await until(() => messagesOf(ids['Marco:dm'] as string).some((m) => m.content === 'On it.'))
    await h.host.idle()
    const wake = h.provider.requests.find((r) => lastInput(r).text.includes('You are free now'))
    expect(lastInput(wake as CompletionRequest).text).toContain(
      'what you were waiting for finished (a request from Theo). Now do what you set aside in this conversation (if you already did it in another conversation, say so in one line instead of redoing it):\n\nQA of PR #24',
    )
    expect(db.prepare("SELECT status FROM set_aside_requests WHERE id = 'sar_1'").get()).toEqual({
      status: 'woken',
    })
  })
})

describe('requests set aside, when things go wrong', () => {
  const waiting = () => h.call<SetAsideRequest[]>('listSetAsideRequests', {}, undefined, {})
  const sessionsTitled = async (title: string) => (await sessions()).filter((s) => s.title === title)
  const wakes = () => h.provider.requests.filter((r) => lastInput(r).text.includes('You are free now')).length

  /** Marco has the QA of #22 open (it never finishes) and Theo's #23 is set aside. */
  async function behindOpenSession(marcoScript: BotScript, idleWatchIntervalMs?: number) {
    await boot(
      { Nina: delegate('#22'), Theo: delegate('#23'), Marco: marcoScript },
      undefined,
      idleWatchIntervalMs,
    )
    const ids = await createBots('Marco', 'Nina', 'Theo')
    await h.call(
      'postMessage',
      { conversationId: ids['Nina:dm'] as string },
      { content: 'send PR #22 to Marco' },
    )
    await until(async () => (await sessionTitled('QA of PR #22'))?.status === 'idle')
    await h.host.idle()
    await h.call(
      'postMessage',
      { conversationId: ids['Theo:dm'] as string },
      { content: 'send PR #23 to Marco' },
    )
    await h.host.idle()
    expect((await waiting()).map((w) => w.task)).toEqual(['QA of PR #23'])
    return ids
  }

  const stopSession = async (title: string) =>
    h.call('stopWorkSession', { sessionId: (await sessionTitled(title))?.id as string })

  it('keeps a request waiting when the turn that wakes the bot with it fails, and wakes it again later', async () => {
    let failWake = true
    const base = marco({ finish: false })
    await behindOpenSession((input) => {
      if (input.text.includes('You are free now') && input.tools === 0 && failWake) return { error: 'boom' }
      return base(input)
    }, 10)
    await stopSession('QA of PR #22')
    await until(() => wakes() > 0)
    await h.host.idle()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await waiting()).toMatchObject([{ task: 'QA of PR #23', status: 'waiting', attempts: 1 }])
    expect(await sessionTitled('QA of PR #23')).toBeUndefined()

    failWake = false
    clock += 5 * 60_000
    await until(async () => Boolean(await sessionTitled('QA of PR #23')))
    await h.host.idle()
    expect(await waiting()).toEqual([])
    expect(
      h.db.prepare("SELECT status, attempts FROM set_aside_requests WHERE task = 'QA of PR #23'").get(),
    ).toEqual({ status: 'woken', attempts: 2 })
  })

  it('stops waking the bot after a few failed wakes and leaves the request pending', async () => {
    const base = marco({ finish: false })
    await behindOpenSession(
      (input) =>
        input.text.includes('You are free now') && input.tools === 0 ? { error: 'boom' } : base(input),
      10,
    )
    await stopSession('QA of PR #22')
    for (let attempt = 1; attempt <= 3; attempt++) {
      await until(async () => (await waiting())[0]?.attempts === attempt)
      await h.host.idle()
      clock += 5 * 60_000
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    await h.host.idle()
    expect(await waiting()).toMatchObject([{ task: 'QA of PR #23', status: 'waiting', attempts: 3 }])
  })

  it('wakes the bot as soon as the user stops its idle session, without waiting for the timer', async () => {
    await behindOpenSession(marco({ finish: false }))
    await stopSession('QA of PR #22')
    await until(async () => Boolean(await sessionTitled('QA of PR #23')), 2000)
  })

  it('lets the bot drop a request set aside in another conversation once it does the work there', async () => {
    const base = marco({ finish: false })
    const ids = await behindOpenSession((input) => {
      const setAside = /"QA of PR #23" \(id (sar_\w+), in your conversation with Theo/.exec(input.input)?.[1]
      if (input.text.endsWith('Run the QA of PR #23 now.') && input.tools === 0 && setAside)
        return {
          toolCalls: [
            { name: 'after_current_work', arguments: { cancel: true, id: setAside } },
            { name: 'session_start', arguments: { title: 'QA of PR #23', goal: 'Check PR #23.' } },
          ],
        }
      return base(input)
    })
    await h.call(
      'postMessage',
      { conversationId: ids['Marco:dm'] as string },
      { content: 'Run the QA of PR #23 now.' },
    )
    await h.host.idle()
    expect(await waiting()).toEqual([])

    await stopSession('QA of PR #22')
    await new Promise((resolve) => setTimeout(resolve, 100))
    await h.host.idle()
    expect(wakes()).toBe(0)
    expect(await sessionsTitled('QA of PR #23')).toHaveLength(1)
  })

  it('drops what was set aside in a conversation the user deletes', async () => {
    const ids = await behindOpenSession(marco({ finish: false }))
    const group = await h.call<{ id: string }>(
      'createConversation',
      {},
      { type: 'group', title: 'Release', botIds: [ids.Marco] },
    )
    h.db
      .prepare(
        `INSERT INTO set_aside_requests (id, bot_id, conversation_id, task, created_at, updated_at)
         VALUES ('sar_group', ?, ?, 'Release notes', ?, ?)`,
      )
      .run(ids.Marco, group.id, clock, clock)
    await h.call('deleteConversation', { conversationId: group.id })
    expect((await waiting()).map((w) => w.task)).toEqual(['QA of PR #23'])
    expect(h.db.prepare("SELECT status FROM set_aside_requests WHERE id = 'sar_group'").get()).toEqual({
      status: 'dropped',
    })
  })

  it('refuses an idle watch bot that does not exist', async () => {
    await boot({})
    await expect(
      h.call('updateWorkspacePreferences', {}, { idleWatchBotId: 'bot_missing' }),
    ).rejects.toThrow()
  })
})
