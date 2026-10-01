import { describe, expect, it } from 'vitest'

import { FakeProvider, type FakeStep } from '../llm/fake'
import type { ChatMessage } from '../llm/messages'
import type { CompletionRequest, StreamChunk } from '../llm/provider'
import { OMITTED_SCREENSHOT } from '../memory/chat-messages'
import { USER_WROTE_MEANWHILE_NOTE } from '../prompts/notes'
import { USER_TOOK_CONTROL_NOTE } from '../prompts/rules'
import { makeBot, screenshotTools, TestEnv } from '../test-support/env'
import { DefaultAgentHost } from './agent-host'

async function setup(script: FakeStep[] | ((req: never, i: number) => FakeStep), options = {}) {
  const provider = new FakeProvider({ script: script as FakeStep[] })
  const env = new TestEnv(provider)
  env.toolHandler = screenshotTools(env)
  const bot = makeBot()
  const conversation = env.addBot(bot)
  const host = new DefaultAgentHost({ deltaFlushMs: 1, ...options })
  await host.start(env)
  const say = (text: string) => host.onMessageCreated(env.userMessage(conversation.id, text))
  return { provider, env, bot, conversation, host, say }
}

const until = async (check: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('DefaultAgentHost', () => {
  it('runs a tool loop, streams text and logs llm/tool calls', async () => {
    const { env, host, bot, say, provider } = await setup([
      {
        text: 'Let me look at the screen.',
        toolCalls: [{ name: 'computer', arguments: { action: 'screenshot' } }],
      },
      { toolCalls: [{ name: 'bash', arguments: { command: `ls ${'/workspace/folder '.repeat(8)}` } }] },
      { text: 'Done: the folder is empty.' },
    ])
    say('what is in /workspace?')
    await host.idle(bot.id)

    // Text before a tool call is narration: it leaves the chat and becomes a note in the activity card.
    const texts = env.messages.filter((m) => m.kind === 'text' && m.authorType === 'bot')
    expect(texts.map((m) => m.content)).toEqual(['Done: the folder is empty.'])
    expect(texts.every((m) => m.payload?.type === 'text' && !m.payload.streaming)).toBe(true)
    expect(env.deltas.map((d) => d.delta).join('')).toBe(
      'Let me look at the screen.Done: the folder is empty.',
    )

    const activity = env.messages.filter((m) => m.kind === 'activity')
    expect(activity).toHaveLength(1)
    const payload = activity[0]?.payload
    if (payload?.type !== 'activity') throw new Error('expected activity payload')
    expect(payload.status).toBe('done')
    expect(payload.steps.map((s) => [s.kind, s.status, s.kind === 'note' ? s.detail : ''])).toEqual([
      ['note', 'ok', 'Let me look at the screen.'],
      ['screenshot', 'ok', ''],
      ['bash', 'ok', ''],
    ])
    expect(payload.steps[1]?.screenshotSha).toMatch(/^[0-9a-f]{64}$/)

    expect(env.llmCalls).toHaveLength(3)
    expect(env.llmCalls.every((c) => c.contextComposition && c.contextComposition.systemPrompt > 100)).toBe(
      true,
    )
    expect([...env.toolCalls.values()].map((t) => [t.toolName, t.status, t.llmCallId !== null])).toEqual([
      ['computer', 'ok', true],
      ['bash', 'ok', true],
    ])
    const done = env.activity.filter((a) => a.status === 'ok')
    expect(done.map((a) => a.kind)).toEqual(['screenshot', 'bash'])
    expect(done[0]?.screenshotSha).toMatch(/^[0-9a-f]{64}$/)
    expect(done[1]?.detail.endsWith('…')).toBe(true)
    expect(done[1]?.fullDetail).toBe(`ls ${'/workspace/folder '.repeat(8)}`.trim())

    const statuses = env.statuses.map((s) => s.status)
    expect(statuses).toContain('thinking')
    expect(statuses).toContain('talking')
    expect(statuses).toContain('working')
    expect(statuses.at(-1)).toBe('idle')

    // The second call sees the tool result with the screenshot as an image part.
    const second = provider.requests[1]?.messages ?? []
    const toolMessage = second.find((m) => m.role === 'tool')
    expect(toolMessage?.content.some((p) => p.type === 'image')).toBe(true)
    expect(second[0]?.role).toBe('system')
  })

  it('takes the step detail a tool reports after running and logs the result size', async () => {
    const { env, host, bot, say } = await setup([
      { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] },
      { text: 'Read it.' },
    ])
    env.toolHandler = async () => ({
      content: [{ type: 'text', text: 'Page: Inbox\n- row: Ana | Contract' }],
      activity: { detail: 'Inbox', fullDetail: 'Inbox — https://mail.google.com/' },
    })
    say('read the page')
    await host.idle(bot.id)
    const payload = env.messages.find((m) => m.kind === 'activity')?.payload
    if (payload?.type !== 'activity') throw new Error('expected activity payload')
    expect(payload.steps.map((s) => [s.kind, s.detail])).toEqual([['browser_snapshot', 'Inbox']])
    const done = env.activity.find((a) => a.status === 'ok')
    expect(done).toMatchObject({
      kind: 'browser_snapshot',
      detail: 'Inbox',
      fullDetail: 'Inbox — https://mail.google.com/',
    })
    expect([...env.toolCalls.values()][0]?.result).toMatchObject({ detail: 'Inbox', tokens: 10 })
  })

  it('keeps only the last two screenshots in the context', async () => {
    const shots = Array.from({ length: 4 }, () => ({
      toolCalls: [{ name: 'computer', arguments: { action: 'screenshot' } }],
    }))
    const { host, bot, say, provider } = await setup([...shots, { text: 'ok' }])
    say('take 4 screenshots')
    await host.idle(bot.id)
    const last = provider.requests.at(-1)?.messages as ChatMessage[]
    const images = last.flatMap((m) => m.content).filter((p) => p.type === 'image')
    const omitted = last
      .flatMap((m) => m.content)
      .filter((p) => p.type === 'text' && p.text === OMITTED_SCREENSHOT)
    expect(images).toHaveLength(2)
    expect(omitted).toHaveLength(2)
  })

  it('closes the turn with a final message after the max step guard', async () => {
    const { env, host, bot, say, provider } = await setup(
      (req: CompletionRequest, i) =>
        req.toolChoice === 'none'
          ? { text: 'Stopped at step 3: two files left.' }
          : { toolCalls: [{ name: 'bash', arguments: { command: `echo ${i}` } }] },
      { maxSteps: 3 },
    )
    say('loop forever')
    await host.idle(bot.id)
    expect(env.llmCalls).toHaveLength(4)
    expect(env.toolLog).toHaveLength(3)
    expect(provider.requests.at(-1)?.toolChoice).toBe('none')
    const line = env.messages.find((m) => m.kind === 'system_event')
    expect(line?.payload).toMatchObject({
      type: 'system',
      event: 'max_steps_reached',
      params: { maxSteps: 3 },
    })
    expect(env.messages.at(-1)).toMatchObject({ kind: 'text', content: 'Stopped at step 3: two files left.' })
  })

  it('pause blocks actions until resume; the in-flight LLM call completes', async () => {
    const { env, host, bot, say } = await setup([
      { toolCalls: [{ name: 'bash', arguments: { command: 'touch a' } }], delayMs: 30 },
      { text: 'done' },
    ])
    say('create a file')
    await until(() => env.statuses.some((s) => s.status === 'thinking'))
    expect(host.control(bot.id, 'pause')).toEqual({ paused: true, control: 'bot', busy: true })
    await until(() => env.llmCalls.length === 1)
    await new Promise((r) => setTimeout(r, 30))
    expect(env.toolLog).toHaveLength(0)
    expect(env.statuses.at(-1)?.status).toBe('paused')

    host.control(bot.id, 'resume')
    await host.idle(bot.id)
    expect(env.toolLog.map((c) => c.name)).toEqual(['bash'])
    expect(env.messages.at(-1)?.content).toBe('done')
  })

  it('after takeover/release refuses stale GUI actions and asks for a screenshot', async () => {
    const { env, host, bot, say, provider } = await setup([
      { toolCalls: [{ name: 'computer', arguments: { action: 'click', x: 10, y: 10 } }], delayMs: 20 },
      { toolCalls: [{ name: 'computer', arguments: { action: 'screenshot' } }] },
      { toolCalls: [{ name: 'computer', arguments: { action: 'click', x: 10, y: 10 } }] },
      { text: 'ok' },
    ])
    say('click it')
    await until(() => env.statuses.some((s) => s.status === 'thinking'))
    expect(host.control(bot.id, 'takeover').control).toBe('user')
    await new Promise((r) => setTimeout(r, 40))
    expect(env.toolLog).toHaveLength(0)
    expect(host.control(bot.id, 'release').paused).toBe(false)
    await host.idle(bot.id)

    // The pending click is refused, the screenshot and the later click run.
    expect(env.toolLog.map((c) => (c.arguments as { action: string }).action)).toEqual([
      'screenshot',
      'click',
    ])
    const notes = provider.requests.flatMap((r) => r.messages).flatMap((m) => m.content)
    expect(notes.some((p) => p.type === 'text' && p.text.includes(USER_TOOK_CONTROL_NOTE))).toBe(true)
    const events = env.messages.filter((m) => m.kind === 'system_event').map((m) => m.payload)
    expect(events.map((p) => (p?.type === 'system' ? p.event : null))).toEqual([
      'user_took_control',
      'user_released_control',
    ])
  })

  it('keeps only the final text as the reply, hides no-op commands and never shows raw arguments', async () => {
    const turns: string[] = []
    const { env, host, bot, say } = await setup([
      { text: 'Checking the team.', toolCalls: [{ name: 'list_bots', arguments: {} }] },
      { text: 'Almost there.', toolCalls: [{ name: 'bash', arguments: { command: 'true' } }] },
      { text: 'All good: the team has 1 bot.' },
    ])
    env.turnFinished = (info) => turns.push(info.reply)
    say('who is on the team?')
    await host.idle(bot.id)

    const texts = env.messages.filter((m) => m.kind === 'text' && m.authorType === 'bot')
    expect(texts.map((m) => m.content)).toEqual(['All good: the team has 1 bot.'])
    const payload = env.messages.find((m) => m.kind === 'activity')?.payload
    if (payload?.type !== 'activity') throw new Error('expected activity payload')
    expect(payload.steps.map((s) => [s.kind, s.detail])).toEqual([
      ['note', 'Checking the team.'],
      ['list_bots', ''],
      ['note', 'Almost there.'],
    ])
    expect(env.activity.map((a) => a.tool)).toEqual(['list_bots', 'list_bots'])
    expect([...env.toolCalls.values()].map((t) => t.toolName)).toEqual(['list_bots', 'bash'])
    expect(turns).toEqual(['All good: the team has 1 bot.'])
  })

  it('stop cancels the running turn and clears the queue', async () => {
    const { env, host, bot, say } = await setup([
      { text: 'starting', toolCalls: [{ name: 'bash', arguments: { command: 'sleep 100' } }] },
      { text: 'never' },
    ])
    env.toolHandler = (ctx) =>
      new Promise((_resolve, reject) =>
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      )
    say('long task')
    await until(() => env.toolLog.length === 1)
    host.control(bot.id, 'stop')
    await host.idle(bot.id)

    const activity = env.messages.find((m) => m.kind === 'activity')?.payload
    expect(activity).toMatchObject({ type: 'activity', status: 'cancelled' })
    expect(activity?.type === 'activity' && activity.steps.find((s) => s.kind === 'bash')?.status).toBe(
      'cancelled',
    )
    expect(env.llmCalls).toHaveLength(1)
    expect(env.messages.some((m) => m.content === 'never')).toBe(false)
    expect(env.messages.some((m) => m.payload?.type === 'system' && m.payload.event === 'turn_stopped')).toBe(
      true,
    )
  })

  it('after stop, late tool calls (Claude Code via MCP) never run until a new turn starts', async () => {
    const { env, host, bot, say } = await setup([{ text: 'ok' }, { text: 'again' }])
    host.control(bot.id, 'stop')
    const late = await host.runTool(bot.id, null, {
      id: 'c1',
      name: 'computer',
      arguments: { action: 'click', x: 1, y: 1 },
    })
    expect(late.isError).toBe(true)
    expect(env.toolLog).toHaveLength(0)

    say('another task')
    await host.idle(bot.id)
    const fresh = await host.runTool(bot.id, null, { id: 'c2', name: 'bash', arguments: { command: 'true' } })
    expect(fresh.isError).toBeFalsy()
    expect(env.toolLog.map((c) => c.name)).toEqual(['bash'])
  })

  it('forwards the streamed input of draft tools (a design frame) and nothing else', async () => {
    class StreamingInput extends FakeProvider {
      override async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk> {
        yield { type: 'tool_input_delta', id: 't1', name: 'design_write_frame', partialJson: '{"html":"<div' }
        yield { type: 'tool_input_delta', id: 't2', name: 'bash', partialJson: '{"command":"ls' }
        yield* super.stream(request)
      }
    }
    const provider = new StreamingInput({ script: [{ text: 'ok' }] })
    const env = new TestEnv(provider)
    const drafts: Array<[string, string, string | undefined]> = []
    env.toolInputDraft = (ctx, name, partial) => drafts.push([name, partial, ctx.toolCallId])
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'draw it'))
    await host.idle(bot.id)
    expect(drafts).toEqual([['design_write_frame', '{"html":"<div', 't1']])
  })

  it('skips a queued turn whose messages the running turn already read', async () => {
    const { env, host, bot, say, provider } = await setup([{ text: 'one', delayMs: 20 }, { text: 'two' }])
    say('first')
    say('second')
    await host.idle(bot.id)
    expect(provider.requests).toHaveLength(1)
    expect(env.messages.filter((m) => m.authorType === 'bot').map((m) => m.content)).toEqual(['one'])
  })

  it('answers a message that arrived during the previous turn, before its reply was written', async () => {
    const { env, host, bot, say, provider } = await setup([{ text: 'one', delayMs: 30 }, { text: 'two' }])
    say('first')
    await until(() => provider.requests.length === 1)
    say('second')
    await host.idle(bot.id)
    expect(provider.requests).toHaveLength(2)
    expect(env.messages.filter((m) => m.authorType === 'bot').map((m) => m.content)).toEqual(['one', 'two'])
  })

  it('takes messages sent while it answers into the same turn, together', async () => {
    const { env, host, bot, say, provider } = await setup([{ text: 'one', delayMs: 20 }, { text: 'two' }])
    say('first')
    await until(() => provider.requests.length === 1)
    say('second')
    say('third')
    await host.idle(bot.id)
    expect(provider.requests).toHaveLength(2)
    const joined = provider.requests[1]?.messages.at(-1)?.content ?? []
    expect(joined.map((p) => (p.type === 'text' ? p.text : ''))).toEqual([
      USER_WROTE_MEANWHILE_NOTE,
      'second',
      'third',
    ])
    expect(env.messages.filter((m) => m.authorType === 'bot').map((m) => m.content)).toEqual(['one', 'two'])
  })

  it('runs a routine turn with its prompt as input and reports how it ended', async () => {
    const { host, bot, conversation, provider } = await setup([
      { text: 'Report closed.' },
      { error: 'HTTP 500: upstream' },
    ])
    const outcomes: string[] = []
    const routine = (note: string) =>
      host.enqueueTurn({
        botId: bot.id,
        conversationId: conversation.id,
        trigger: 'routine',
        note,
        onFinished: (outcome) => outcomes.push(outcome),
      })
    routine('[Milibot] Routine "Report": close the monthly report.')
    await host.idle(bot.id)
    const input = provider.requests[0]?.messages.at(-1)
    expect(input?.role).toBe('user')
    expect(input?.content.some((p) => p.type === 'text' && p.text.includes('close the monthly report'))).toBe(
      true,
    )
    expect(provider.requests[0]?.tools.length).toBeGreaterThan(0)
    expect(outcomes).toEqual(['done'])
    routine('again')
    await host.idle(bot.id)
    expect(outcomes).toEqual(['done', 'error'])
  })

  it('reports queued routine turns dropped by stop as cancelled', async () => {
    const { env, host, bot, conversation, say } = await setup([
      { text: 'starting', toolCalls: [{ name: 'bash', arguments: { command: 'sleep 100' } }] },
    ])
    env.toolHandler = (ctx) =>
      new Promise((_resolve, reject) =>
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      )
    say('long task')
    await until(() => env.toolLog.length === 1)
    const outcomes: string[] = []
    host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'routine',
      note: 'routine',
      onFinished: (outcome) => outcomes.push(outcome),
    })
    host.control(bot.id, 'stop')
    await host.idle(bot.id)
    expect(outcomes).toEqual(['cancelled'])
  })

  it('introduces a new bot without tools', async () => {
    const { env, host, bot, conversation, provider } = await setup([{ text: 'Hi! I am Ana.' }])
    host.enqueueTurn({ botId: bot.id, conversationId: conversation.id, trigger: 'intro' })
    await host.idle(bot.id)
    expect(provider.requests[0]?.tools).toEqual([])
    expect(env.llmCalls[0]?.purpose).toBe('intro')
    expect(env.messages.at(-1)?.content).toBe('Hi! I am Ana.')
  })

  it('logs side text a tool asks for under the turn it works for', async () => {
    const { env, host, bot, conversation } = await setup([{ text: 'The price is $10.' }])
    const { text } = await host.writeText({
      botId: bot.id,
      conversationId: conversation.id,
      turnId: 'turn_1',
      purpose: 'web_fetch',
      system: 'Read the page.',
      prompt: 'Price?',
      maxOutputTokens: 100,
    })
    expect(text).toBe('The price is $10.')
    expect(env.llmCalls.map((c) => [c.purpose, c.turnId])).toEqual([['web_fetch', 'turn_1']])
  })

  it('refuses a tool call the turn did not offer', async () => {
    const { env, host, bot, conversation, provider } = await setup([
      { toolCalls: [{ name: 'bash', arguments: { command: 'rm -rf /workspace' } }] },
      { text: 'Hi! I am Ana.' },
    ])
    host.enqueueTurn({ botId: bot.id, conversationId: conversation.id, trigger: 'intro' })
    await host.idle(bot.id)
    expect(env.toolLog).toHaveLength(0)
    expect([...env.toolCalls.values()]).toMatchObject([{ toolName: 'bash', status: 'error' }])
    const refusal = provider.requests[1]?.messages.at(-1)
    expect(refusal).toMatchObject({ role: 'tool', toolName: 'bash', isError: true })
    expect(JSON.stringify(refusal)).toContain('not available in this turn')
    expect(env.messages.at(-1)?.content).toBe('Hi! I am Ana.')
  })

  it('names the right tool when the model calls one borrowed from another harness', async () => {
    const { host, bot, say, provider } = await setup([
      { toolCalls: [{ name: 'write', arguments: { path: '/workspace/a.txt', content: 'a' } }] },
      { text: 'ok' },
    ])
    say('write a file')
    await host.idle(bot.id)
    expect(JSON.stringify(provider.requests[1]?.messages.at(-1))).toContain(
      'there is no tool named write; use file_write',
    )
  })

  it('reports provider errors as an error card', async () => {
    const { env, host, bot, say } = await setup([{ error: 'HTTP 401: invalid key' }])
    say('hi')
    await host.idle(bot.id)
    expect(env.messages.at(-1)).toMatchObject({
      kind: 'card',
      payload: { type: 'error', code: 'provider_error' },
    })
    expect(env.llmCalls[0]?.error).toContain('invalid key')
  })

  it('runs MCP tool calls through the pause gate and the current turn', async () => {
    const { env, host, bot } = await setup([])
    host.control(bot.id, 'pause')
    const pending = host.runTool(bot.id, null, { id: 'x', name: 'list_bots', arguments: {} })
    await new Promise((r) => setTimeout(r, 20))
    expect(env.toolLog).toHaveLength(0)
    host.control(bot.id, 'resume')
    const result = await pending
    expect(result.content[0]).toEqual({ type: 'text', text: 'ran list_bots' })
    expect([...env.toolCalls.values()][0]).toMatchObject({
      toolName: 'list_bots',
      status: 'ok',
      turnId: null,
    })
  })

  it('posts an error card and goes idle when a turn crashes', async () => {
    const { env, host, bot, say } = await setup([{ text: 'never' }])
    env.resolveModel = async () => {
      throw new Error('guest agent unreachable: fetch failed')
    }
    say('hi')
    await host.idle(bot.id)
    expect(env.messages.at(-1)).toMatchObject({
      kind: 'card',
      authorBotId: bot.id,
      payload: { type: 'error', code: 'turn_crashed', detail: 'guest agent unreachable: fetch failed' },
    })
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'idle' })
  })

  it('starts a turn only after its waitFor settles (new bot desktop)', async () => {
    const { env, host, bot, conversation, provider } = await setup([{ text: 'Hi! I am Ana.' }])
    let provisioned!: () => void
    const desktop = new Promise<void>((resolve) => (provisioned = resolve))
    host.enqueueTurn({ botId: bot.id, conversationId: conversation.id, trigger: 'intro', waitFor: desktop })
    await new Promise((r) => setTimeout(r, 20))
    expect(provider.requests).toHaveLength(0)
    provisioned()
    await host.idle(bot.id)
    expect(env.messages.at(-1)?.content).toBe('Hi! I am Ana.')
  })

  it('still introduces the bot when provisioning its desktop failed', async () => {
    const { env, host, bot, conversation } = await setup([{ text: 'Hi! I am Ana.' }])
    host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'intro',
      waitFor: Promise.reject(new Error('provision failed')),
    })
    await host.idle(bot.id)
    expect(env.messages.at(-1)?.content).toBe('Hi! I am Ana.')
  })

  it('pauses an idle bot: status paused, kept across restarts, messages wait until resume', async () => {
    const { env, host, bot, say, provider } = await setup([{ text: 'I am back!' }])
    const screen = host.control(bot.id, 'pause')
    expect(screen).toMatchObject({ paused: true, control: 'idle', busy: false })
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'paused' })
    expect(env.settings[`bot.paused.${bot.id}`]).toBe(true)

    say('hi')
    await host.idle(bot.id)
    expect(provider.requests).toHaveLength(0)
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'paused' })
    expect(host.screenState(bot.id)).toMatchObject({ paused: true, busy: true })

    // A new runtime keeps the bot paused.
    const again = new DefaultAgentHost({ deltaFlushMs: 1 })
    await again.start(env)
    expect(again.screenState(bot.id).paused).toBe(true)
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'paused' })
    await again.stop()

    host.control(bot.id, 'resume')
    expect(env.settings[`bot.paused.${bot.id}`]).toBe(false)
    await host.idle(bot.id)
    expect(env.messages.at(-1)?.content).toBe('I am back!')
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'idle' })
  })

  it('stop drops turns waiting for a paused bot, says so in the chat and keeps it paused', async () => {
    const { env, host, bot, say, provider } = await setup([{ text: 'never' }])
    host.control(bot.id, 'pause')
    say('do this')
    expect(host.screenState(bot.id).busy).toBe(true)
    const screen = host.control(bot.id, 'stop')
    expect(screen).toMatchObject({ busy: false, paused: true })
    expect(env.messages.some((m) => m.payload?.type === 'system' && m.payload.event === 'turn_stopped')).toBe(
      true,
    )
    await host.idle(bot.id)
    expect(provider.requests).toHaveLength(0)
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'paused' })
  })

  it('says a queued turn was stopped in the conversation it was queued for', async () => {
    const { env, host, bot } = await setup([{ text: 'never' }])
    const group = env.addGroup([bot.id])
    host.control(bot.id, 'pause')
    host.enqueueTurn({ botId: bot.id, conversationId: group.id, trigger: 'group_message' })
    host.control(bot.id, 'stop')
    const stopped = env.messages.find(
      (m) => m.payload?.type === 'system' && m.payload.event === 'turn_stopped',
    )
    expect(stopped?.conversationId).toBe(group.id)
    await host.idle(bot.id)
  })

  it('marks a bot busy as soon as its message is accepted, even while it waits for a slot', async () => {
    const { env, host, bot, say } = await setup([{ text: 'one', delayMs: 30 }, { text: 'two' }])
    env.settings['agents.max_parallel'] = 1
    const other = makeBot({ name: 'Bia', slug: 'bia', displayNum: 2 })
    const otherDm = env.addBot(other)
    say('hi')
    expect(env.statuses.at(-1)).toEqual({ botId: bot.id, status: 'thinking' })
    host.onMessageCreated(env.userMessage(otherDm.id, 'hi Bia'))
    expect(env.statuses.at(-1)).toEqual({ botId: other.id, status: 'thinking' })
    expect(host.screenState(other.id).control).toBe('idle')
    await host.idle()
    const otherStatuses = env.statuses.filter((s) => s.botId === other.id).map((s) => s.status)
    expect(otherStatuses[0]).toBe('thinking')
    expect(otherStatuses.at(-1)).toBe('idle')
    expect(otherStatuses.slice(0, -1)).not.toContain('idle')
  })

  it('stays busy between queued turns', async () => {
    const { env, host, bot, say } = await setup([{ text: 'one', delayMs: 20 }, { text: 'two' }])
    const other = env.addBot(makeBot({ id: 'bot_x', name: 'X', slug: 'x' }))
    other.memberBotIds = [bot.id]
    say('first')
    host.onMessageCreated(env.userMessage(other.id, 'second'))
    await host.idle(bot.id)
    const statuses = env.statuses.filter((s) => s.botId === bot.id).map((s) => s.status)
    expect(statuses.filter((s) => s === 'idle')).toHaveLength(1)
    expect(statuses.at(-1)).toBe('idle')
  })
  it('a tool waiting on the user frees its parallel slot and gets it back afterwards', async () => {
    const { env, host, bot, say } = await setup([
      { toolCalls: [{ name: 'ask_user', arguments: { questions: [] } }] },
      { text: 'Bia answered' },
      { text: 'Ana finished' },
    ])
    env.settings['agents.max_parallel'] = 1
    let answer: (value: string) => void = () => undefined
    env.toolHandler = async (ctx) => {
      const value = await ctx.detach!(new Promise<string>((resolve) => (answer = resolve)))
      return { content: [{ type: 'text', text: value }] }
    }
    const other = makeBot({ name: 'Bia', slug: 'bia', displayNum: 2 })
    const otherDm = env.addBot(other)
    say('ask me')
    await until(() => env.statuses.some((s) => s.botId === bot.id && s.detail === 'ask_user'))
    expect(env.statuses.filter((s) => s.botId === bot.id).at(-1)).toMatchObject({
      status: 'working',
      detail: 'ask_user',
    })
    host.onMessageCreated(env.userMessage(otherDm.id, 'hi Bia'))
    await host.idle(other.id)
    expect(env.messages.some((m) => m.content === 'Bia answered')).toBe(true)
    answer('Everyone')
    await host.idle(bot.id)
    expect(env.messages.some((m) => m.content === 'Ana finished')).toBe(true)
    expect(env.toolCalls.size).toBe(1)
    expect([...env.toolCalls.values()][0]).toMatchObject({ status: 'ok' })
  })

  it('stopping a bot while its tool waits on the user cancels the wait and frees the bot', async () => {
    const { env, host, bot, say } = await setup([
      { toolCalls: [{ name: 'ask_user', arguments: { questions: [] } }] },
      { text: 'again' },
    ])
    env.settings['agents.max_parallel'] = 1
    let aborted = false
    env.toolHandler = async (ctx) =>
      ctx.detach!(
        new Promise<never>((_, reject) =>
          ctx.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('stopped'))
          }),
        ),
      )
    say('question')
    await until(() => env.statuses.some((s) => s.detail === 'ask_user'))
    host.control(bot.id, 'stop')
    await host.idle(bot.id)
    expect(aborted).toBe(true)
    expect([...env.toolCalls.values()][0]).toMatchObject({ status: 'cancelled' })
    say('again?')
    await host.idle(bot.id)
    expect(env.messages.at(-1)?.content).toBe('again')
  })
})
