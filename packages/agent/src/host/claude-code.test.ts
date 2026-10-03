import { cliSettingKeys } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { ClaudeCodeSessions } from '../claude-code/sessions'
import type { GuestProcSpec } from '../cli/backend'
import { cliKeys } from '../cli/keys'
import { cliPrompt } from '../cli/prompt'
import type { CliSessionMeta } from '../cli/rotation'
import type { WorkSessionDirectory } from '../environment'
import { FakeProvider } from '../llm/fake'
import { USER_WROTE_MEANWHILE_NOTE } from '../prompts/notes'
import { claudeProfile, FakeBackend } from '../test-support/claude-code'
import { makeBot, TestEnv } from '../test-support/env'
import { fakeRepoInstructions } from '../test-support/repo-instructions'
import { DefaultAgentHost } from './agent-host'
import { sessionLaneKey } from './lanes'

describe('DefaultAgentHost with Claude Code', () => {
  const line = (event: Record<string, unknown>) =>
    JSON.stringify({ ...event, session_id: 'sess-1', parent_tool_use_id: null })
  const toolUse = (id: string, name: string, input: unknown) =>
    line({
      type: 'assistant',
      message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    })
  const toolResult = (id: string, text: string) =>
    line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
    })
  const reply = (id: string, text: string) =>
    line({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } })
  const result = (text: string) => line({ type: 'result', subtype: 'success', is_error: false, result: text })
  const replay = (text: string) =>
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, isReplay: true })
  const pushTo = (backend: FakeBackend) => (data: string) =>
    (backend as unknown as { push(id: string, e: Record<string, unknown>): void }).push('proc-1', {
      type: 'stdout',
      data,
    })
  const until = async (check: () => boolean) => {
    const started = Date.now()
    while (!check()) {
      if (Date.now() - started > 2000) throw new Error('condition not met in time')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  it('hides internal tools from activity steps but keeps them in tool_calls', async () => {
    const backend = new FakeBackend()
    backend.script = [
      line({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'milibot', status: 'connected' }] }),
      toolUse('t1', 'ToolSearch', { query: 'select:mcp__milibot__computer', max_results: 1 }),
      toolResult('t1', 'found'),
      toolUse('t2', 'TodoWrite', { todos: [] }),
      toolResult('t2', 'ok'),
      toolUse('t3', 'Bash', { command: 'uname -a', description: 'Kernel' }),
      toolResult('t3', 'Linux'),
      toolUse('t4', 'WebFetch', { url: 'https://www.debian.org/', prompt: 'release?' }),
      toolResult('t4', 'Debian 13'),
      line({
        type: 'assistant',
        message: { id: 'm-end', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.01 }),
    ]
    const provider = new FakeProvider({ script: [] })
    const env = new TestEnv(provider)
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'which kernel?'))
    await host.idle(bot.id)

    const activity = env.messages.find((m) => m.kind === 'activity')
    if (activity?.payload?.type !== 'activity') throw new Error('expected an activity card')
    expect(activity.payload.steps.map((s) => [s.kind, s.detail, s.status])).toEqual([
      ['bash', 'uname -a', 'ok'],
      ['web_fetch', 'https://www.debian.org/', 'ok'],
    ])
    expect(activity.content).toBe('terminal: uname -a\nopen: https://www.debian.org/')
    expect(env.activity.map((a) => a.tool)).not.toContain('ToolSearch')
    expect([...env.toolCalls.values()].map((t) => [t.toolName, t.status])).toEqual([
      ['ToolSearch', 'ok'],
      ['TodoWrite', 'ok'],
      ['Bash', 'ok'],
      ['WebFetch', 'ok'],
    ])
    expect(env.statuses.some((s) => s.status === 'working' && s.detail === 'ToolSearch')).toBe(false)
    await host.stop()
  })

  it('shows a Claude Code error, not a crash, when its process cannot start', async () => {
    const backend = new FakeBackend()
    backend.startProcess = async () => {
      throw new Error('VM_UNAVAILABLE')
    }
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    const card = env.messages.find((m) => m.payload?.type === 'error')
    expect(card?.payload).toMatchObject({
      type: 'error',
      code: 'cli_error',
      params: { engine: 'claude_code' },
    })
    expect(env.llmCalls.at(-1)?.error).toMatch(/VM_UNAVAILABLE/)
    await host.stop()
  })

  it('puts the files native Edit/Write changed on the step and their patches on the tool call', async () => {
    const backend = new FakeBackend()
    const fileResult = (id: string, toolUseResult: unknown) =>
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
        tool_use_result: toolUseResult,
      })
    backend.script = [
      line({ type: 'system', subtype: 'init', mcp_servers: [] }),
      toolUse('t1', 'Edit', { file_path: '/workspace/app/a.ts', old_string: 'x = 1', new_string: 'x = 2' }),
      fileResult('t1', {
        filePath: '/workspace/app/a.ts',
        oldString: 'x = 1',
        newString: 'x = 2',
        originalFile: 'big file',
        structuredPatch: [
          {
            oldStart: 10,
            oldLines: 2,
            newStart: 10,
            newLines: 3,
            lines: [' a', '-x = 1', '+x = 2', '+y = 3'],
          },
        ],
      }),
      toolUse('t2', 'Write', { file_path: '/workspace/app/new.md', content: 'hi\nthere\n' }),
      fileResult('t2', {
        type: 'create',
        filePath: '/workspace/app/new.md',
        content: 'hi\nthere\n',
        structuredPatch: [],
      }),
      toolUse('t3', 'Edit', { file_path: '/workspace/app/b.ts', old_string: 'a\nb', new_string: 'a\nc' }),
      toolResult('t3', 'done'),
      line({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.01 }),
    ]
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'edita'))
    await host.idle(bot.id)

    const activity = env.messages.find((m) => m.kind === 'activity')
    if (activity?.payload?.type !== 'activity') throw new Error('expected an activity card')
    expect(activity.payload.steps.map((s) => s.files)).toEqual([
      [{ path: '/workspace/app/a.ts', status: 'modified', additions: 2, deletions: 1 }],
      [{ path: '/workspace/app/new.md', status: 'added', additions: 2, deletions: 0 }],
      [{ path: '/workspace/app/b.ts', status: 'modified', additions: 1, deletions: 1 }],
    ])
    const diffs = [...env.toolCalls.values()].map((t) => (t as { diffs?: Array<{ patch: string }> }).diffs)
    expect(diffs.map((d) => d?.[0]?.patch)).toEqual([
      '@@ -10,2 +10,3 @@\n a\n-x = 1\n+x = 2\n+y = 3',
      '@@ -0,0 +1,2 @@\n+hi\n+there',
      '@@ -1,2 +1,2 @@\n a\n-b\n+c',
    ])
    expect(JSON.stringify(diffs)).not.toContain('big file')
    await host.stop()
  })

  it('hands a message the user sends mid-turn to the running process, which answers it in the same turn', async () => {
    const backend = new FakeBackend()
    const init = line({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'milibot', status: 'connected' }],
    })
    let writes = 0
    backend.scriptFor = () =>
      ++writes === 1 ? [init, toolUse('t1', 'Bash', { command: 'make screens' })] : []
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'draw the screens'))
    await until(() => env.activity.some((a) => a.tool === 'Bash'))
    host.onMessageCreated(env.userMessage(conversation.id, 'actually, make it all dark'))
    await until(() => backend.stdin.length === 2)
    const sent = JSON.parse(backend.stdin[1] as string).message.content[0].text as string
    expect(sent).toContain(USER_WROTE_MEANWHILE_NOTE)
    expect(sent).toContain('actually, make it all dark')

    const push = pushTo(backend)
    push(toolResult('t1', 'drawn'))
    push(reply('m1', 'Light screens drawn.'))
    // The message came after the last step: the CLI answers it after its result, in the same turn.
    push(result('Light screens drawn.'))
    push(replay(sent))
    push(reply('m2', 'Switched them all to dark.'))
    push(result('Switched them all to dark.'))
    await host.idle(bot.id)

    expect(backend.stdin).toHaveLength(2)
    expect(backend.signals).toEqual([])
    const texts = env.messages
      .filter((m) => m.kind === 'text' && m.authorType === 'bot')
      .map((m) => m.content)
    expect(texts).toEqual(['Light screens drawn.', 'Switched them all to dark.'])
    const order = env.messages.map((m) => m.content)
    expect(order.indexOf('actually, make it all dark')).toBeLessThan(
      order.indexOf('Switched them all to dark.'),
    )
    await host.stop()
  })

  it('records the turn as running at its first model request, updates it after each one, then completes it', async () => {
    const backend = new FakeBackend()
    const used = (id: string, content: unknown[], usage: Record<string, number>) =>
      line({ type: 'assistant', message: { id, role: 'assistant', content, usage } })
    let writes = 0
    backend.scriptFor = () =>
      ++writes === 1
        ? [
            line({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', mcp_servers: [] }),
            used('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], {
              input_tokens: 10,
              cache_read_input_tokens: 1000,
              output_tokens: 20,
            }),
          ]
        : []
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'list the folder'))

    // Shown while the turn still runs.
    await until(() => env.llmCallWrites.length === 1)
    expect(env.llmCallWrites[0]).toMatchObject({
      purpose: 'turn',
      conversationId: conversation.id,
      stopReason: 'running',
      model: 'claude-sonnet-4-5',
      usage: { inputTokens: 10, cachedReadTokens: 1000, outputTokens: 20 },
      response: { requests: 1 },
    })

    const push = pushTo(backend)
    push(toolResult('t1', 'a.ts'))
    env.advance(2_000)
    push(
      used('m2', [{ type: 'text', text: 'One file: a.ts.' }], {
        input_tokens: 10,
        cache_read_input_tokens: 1100,
        output_tokens: 8,
      }),
    )
    await until(() => env.llmCallWrites.length === 2)
    expect(env.llmCallWrites[1]).toMatchObject({
      stopReason: 'running',
      usage: { cachedReadTokens: 2100, outputTokens: 28 },
      response: { requests: 2 },
    })

    push(result('One file: a.ts.'))
    await host.idle(bot.id)
    const id = env.llmCallWrites[0]?.id
    expect(env.llmCallWrites.map((w) => w.id)).toEqual([id, id, id])
    expect(env.llmCallWrites[2]).toMatchObject({ stopReason: 'success', response: { requests: 2 } })
    expect(env.llmCalls.filter((c) => c.purpose === 'turn')).toHaveLength(1)
    await host.stop()
  })

  it('queues a message that arrives after the process finished its turn', async () => {
    const backend = new FakeBackend()
    let writes = 0
    backend.scriptFor = () =>
      ++writes === 1
        ? [
            line({ type: 'system', subtype: 'init', mcp_servers: [] }),
            toolUse('t1', 'Bash', { command: 'ls' }),
          ]
        : [reply(`m${writes}`, 'Second answer.'), result('Second answer.')]
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'list the files'))
    await until(() => env.activity.some((a) => a.tool === 'Bash'))
    const push = pushTo(backend)
    push(toolResult('t1', 'a.ts'))
    push(reply('m1', 'One file.'))
    push(result('One file.'))
    await until(() => env.messages.some((m) => m.content === 'One file.'))
    host.onMessageCreated(env.userMessage(conversation.id, 'and now?'))
    await host.idle(bot.id)
    expect(backend.stdin.at(-1)).toContain('and now?')
    expect(
      env.messages.filter((m) => m.kind === 'text' && m.authorType === 'bot').map((m) => m.content),
    ).toEqual(['One file.', 'Second answer.'])
    await host.stop()
  })

  it('launches claude -p with the lane model and its effort, output cap and context limit', async () => {
    const backend = new FakeBackend()
    backend.script = [
      line({ type: 'system', subtype: 'init', mcp_servers: [] }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'Ok.' }),
    ]
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    const asked: Array<string | undefined> = []
    env.resolveModel = async (_bot, options) => {
      asked.push(options?.laneKey)
      return {
        kind: 'cli',
        engine: 'claude_code',
        providerId: 'prv_cc',
        model: 'opus',
        env: { ANTHROPIC_API_KEY: 'k' },
        idleTimeoutMs: 60_000,
        effort: 'high',
        contextLimit: 150_000,
        maxOutputTokens: 32_000,
      }
    }
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)

    const spec = backend.specs[0] as GuestProcSpec
    expect(spec.argv.slice(-2)).toEqual(['--model', 'opus'])
    expect(spec.env).toMatchObject({
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    })
    expect(asked).toEqual([bot.id])
    await host.stop()
  })

  it('streams Claude Code text deltas into one chat message', async () => {
    const backend = new FakeBackend()
    const delta = (text: string) =>
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      })
    backend.script = [
      line({ type: 'system', subtype: 'init', mcp_servers: [] }),
      line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }),
      delta('Hi, '),
      delta('all '),
      delta('good?'),
      line({
        type: 'assistant',
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hi, all good?' }] },
      }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'Hi, all good?' }),
    ]
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)

    const replies = env.messages.filter((m) => m.authorType === 'bot' && m.kind === 'text')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      content: 'Hi, all good?',
      payload: { type: 'text', streaming: false },
    })
    expect(env.deltas.map((d) => d.delta).join('')).toBe('Hi, all good?')
    expect(env.deltas.every((d) => d.messageId === replies[0]?.id)).toBe(true)
    expect(env.statuses.map((s) => s.status)).toContain('talking')
    await host.stop()
  })

  it('folds text written between tool calls into the activity card and hides no-op commands', async () => {
    const backend = new FakeBackend()
    const delta = (text: string) =>
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      })
    const text = (id: string, value: string) =>
      line({
        type: 'assistant',
        message: { id, role: 'assistant', content: [{ type: 'text', text: value }] },
      })
    const start = (id: string) =>
      line({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
    backend.script = [
      line({ type: 'system', subtype: 'init', mcp_servers: [] }),
      start('m1'),
      delta('Text removed. '),
      delta('Sending it now.'),
      text('m1', 'Text removed. Sending it now.'),
      toolUse('t1', 'Bash', { command: 'true' }),
      toolResult('t1', ''),
      start('m2'),
      text('m2', 'Checking the team.'),
      toolUse('t2', 'mcp__milibot__list_bots', {}),
      toolResult('t2', '[]'),
      start('m3'),
      text('m3', 'Opening the site.'),
      toolUse('t3', 'WebFetch', { url: 'https://example.com/' }),
      toolResult('t3', 'ok'),
      start('m4'),
      delta('Sent '),
      delta('to Beatriz.'),
      text('m4', 'Sent to Beatriz.'),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'Sent to Beatriz.' }),
    ]
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'send the email'))
    await host.idle(bot.id)

    const replies = env.messages.filter((m) => m.authorType === 'bot' && m.kind === 'text')
    expect(replies.map((m) => m.content)).toEqual(['Sent to Beatriz.'])
    const activity = env.messages.find((m) => m.kind === 'activity')
    if (activity?.payload?.type !== 'activity') throw new Error('expected an activity card')
    expect(activity.payload.steps.map((s) => [s.kind, s.detail])).toEqual([
      ['note', 'Text removed. Sending it now.'],
      ['note', 'Checking the team.'],
      ['note', 'Opening the site.'],
      ['web_fetch', 'https://example.com/'],
    ])
    expect([...env.toolCalls.values()].map((t) => t.toolName)).toEqual(['Bash', 'WebFetch'])
    await host.stop()
  })
})

describe('Claude Code memory', () => {
  function ccEnv() {
    const backend = new FakeBackend()
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const appendArg = (i: number) => backend.appendedPrompts[i] ?? ''
    return { backend, env, bot, conversation, appendArg }
  }

  it('injects memory and a recap when the session starts fresh, and records the composition', async () => {
    const { env, bot, conversation, appendArg } = ccEnv()
    env.memory.saveNote({ botId: bot.id, content: 'The user is called Fernanda.', pinned: true })
    env.userMessage(conversation.id, 'message from yesterday')
    env.appendMessage({
      conversationId: conversation.id,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'text',
      content: 'answer from yesterday',
      payload: { type: 'text', streaming: false, turnId: 't0' },
    })
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'list the files'))
    await host.idle(bot.id)

    const append = appendArg(0)
    expect(append).toContain('# Milibot memory')
    expect(append).toContain('The user is called Fernanda.')
    expect(append).toContain('answer from yesterday')
    expect(append).not.toContain('list the files')
    const call = env.llmCalls.find((c) => c.purpose === 'turn')
    expect(call?.contextComposition).toMatchObject({ retrieved: 0 })
    expect(call?.contextComposition?.longTermMemory).toBeGreaterThan(0)
    expect(call?.contextComposition?.recentTail).toBeGreaterThan(0)
    expect(call?.request).toMatchObject({ freshSession: true })
    await host.stop()
  })

  it('delivers workspace memory changes to a resumed session as a note', async () => {
    const { backend, env, bot, conversation, appendArg } = ccEnv()
    env.memory.saveNote({
      botId: bot.id,
      content: 'The user lives in Portugal.',
      pinned: true,
      scope: 'workspace',
    })
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    expect(appendArg(0)).toContain('# Workspace memory')
    expect(appendArg(0)).toContain('The user lives in Portugal.')

    env.memory.saveNote({
      botId: 'bot_other',
      content: 'Currency: euro (€).',
      pinned: true,
      scope: 'workspace',
    })
    await host.stop()
    const host2 = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host2.start(env)
    host2.onMessageCreated(env.userMessage(conversation.id, 'what now?'))
    await host2.idle(bot.id)
    expect(backend.specs[1]?.argv).toContain('--resume')
    const input = JSON.parse(backend.stdin.filter(Boolean).at(-1) as string).message.content[0].text as string
    expect(input).toContain('Your memory changed')
    expect(input).toContain('Currency: euro (€).')
    await host2.stop()
  })

  it('resumes with the same appendix and sends memory changes before the first input', async () => {
    const { backend, env, bot, conversation, appendArg } = ccEnv()
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    const firstAppend = appendArg(0)

    env.memory.saveNote({ botId: bot.id, content: 'The project is called Tangerine.', pinned: true })
    await host.stop() // closes the process; the session id stays stored
    const host2 = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host2.start(env)
    host2.onMessageCreated(env.userMessage(conversation.id, 'what now?'))
    await host2.idle(bot.id)

    const argv = backend.specs[1]?.argv ?? []
    expect(argv[argv.indexOf('--resume') + 1]).toBe('8f3c2a1e-0000-4000-8000-000000000001')
    expect(appendArg(1)).toBe(firstAppend)
    const input = JSON.parse(backend.stdin.filter(Boolean).at(-1) as string).message.content[0].text as string
    expect(input).toContain('Your memory changed')
    expect(input).toContain('The project is called Tangerine.')
    expect(input.endsWith('what now?')).toBe(true)

    // Unchanged memory: no note on the next resume.
    await host2.stop()
    const host3 = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host3.start(env)
    host3.onMessageCreated(env.userMessage(conversation.id, 'again'))
    await host3.idle(bot.id)
    expect(JSON.parse(backend.stdin.filter(Boolean).at(-1) as string).message.content[0].text).toBe('again')
    await host3.stop()

    // Removed notes are reported too, so the session stops relying on them.
    env.memory.notes = []
    const host4 = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host4.start(env)
    host4.onMessageCreated(env.userMessage(conversation.id, 'what now?'))
    await host4.idle(bot.id)
    expect(JSON.parse(backend.stdin.filter(Boolean).at(-1) as string).message.content[0].text).toContain(
      'now empty',
    )
    await host4.stop()
  })

  it('starts a fresh session with the recap when the stored one no longer exists', async () => {
    const { backend, env, bot, conversation, appendArg } = ccEnv()
    backend.setSessionId(bot.id, 'gone-session')
    env.setSetting(cliKeys('claude_code').meta(bot.id), {
      sessionId: 'gone-session',
      profile: claudeProfile(cliPrompt('claude_code', bot, env.listBots(), env.userLanguage())),
      model: null,
      lastUsedAt: env.now(),
      contextTokens: 20_000,
      baseTokens: null,
    })
    backend.scriptFor = (procId) =>
      procId === 'proc-1'
        ? [
            JSON.stringify({
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              session_id: 'gone-session',
              errors: ['No conversation found with session ID: gone-session'],
            }),
          ]
        : null
    env.memory.saveNote({ botId: bot.id, content: 'Important reminder.', pinned: true })
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'list the files'))
    await host.idle(bot.id)

    expect(backend.specs).toHaveLength(2)
    expect(backend.specs[0]?.argv).toContain('--resume')
    expect(backend.specs[1]?.argv).not.toContain('--resume')
    expect(appendArg(1)).toContain('Important reminder.')
    expect(backend.getSessionId(bot.id)).toBe('8f3c2a1e-0000-4000-8000-000000000001')
    expect(env.messages.some((m) => m.kind === 'card')).toBe(false)
    expect(env.messages.filter((m) => m.authorType === 'bot' && m.kind === 'text').at(-1)?.content).toBe(
      'The folder is empty.',
    )
    await host.stop()
  })

  it('summarizes with a one-shot claude -p when the bot runs on Claude Code', async () => {
    const backend = new FakeBackend()
    const sessions = new ClaudeCodeSessions(backend)
    backend.scriptFor = () => [
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '- summary',
        total_cost_usd: 0.002,
        usage: { input_tokens: 500, output_tokens: 20 },
      }),
    ]
    const pending = sessions.oneShot({
      bot: makeBot(),
      model: null,
      env: {},
      systemPrompt: 'summarize',
      prompt: 'transcript',
    })
    await new Promise((r) => setTimeout(r, 10))
    await backend.signal('proc-1', 'SIGTERM')
    const result = await pending
    expect(result).toMatchObject({ text: '- summary', error: null })
    expect(result.billing.usage.costUsd).toBe(0.002)
    const argv = backend.specs[0]?.argv ?? []
    expect(argv).toEqual(
      expect.arrayContaining(['--no-session-persistence', '--output-format', 'json', '--tools', '']),
    )
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe('summarize')
    expect(argv).not.toContain('--resume')
  })
})

describe('routine runs on Claude Code', () => {
  const instructions =
    '[Milibot] Routine "Report" (every day at 08:00) ran at 2026-09-26 08:00: its schedule started it.\n\nRoutine instructions:\nClose the daily report.'

  function ccRoutineEnv() {
    const backend = new FakeBackend()
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: null,
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const input = (i: number) => JSON.parse(backend.stdin[i] as string).message.content[0].text as string
    return { backend, env, bot, conversation, input }
  }

  it('sends the run card as the input of the routine turn', async () => {
    const { env, bot, conversation, input } = ccRoutineEnv()
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    env.routineRun(conversation.id, bot.id, instructions)
    host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'routine',
      routineId: 'rtn_1',
    })
    await host.idle(bot.id)
    expect(input(0)).toBe(instructions)
    await host.stop()
  })

  it('still sends it when the bot answered something else after the card', async () => {
    const { env, bot, conversation, input } = ccRoutineEnv()
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    env.routineRun(conversation.id, bot.id, instructions)
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
    expect(input(0)).toContain('Routine instructions:\nClose the daily report.')
    await host.stop()
  })

  it('recaps the routine instructions when a later session starts fresh', async () => {
    const { env, bot, conversation, backend } = ccRoutineEnv()
    env.routineRun(conversation.id, bot.id, instructions)
    env.appendMessage({
      conversationId: conversation.id,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'text',
      content: 'Report closed.',
      payload: { type: 'text', streaming: false, turnId: 't0' },
    })
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'and tomorrow?'))
    await host.idle(bot.id)
    const append = backend.appendedPrompts[0] ?? ''
    expect(append).toContain('Routine instructions:')
    expect(append).toContain('Close the daily report.')
    await host.stop()
  })
})

describe('Claude Code in a work session lane', () => {
  function sessionEnv() {
    const backend = new FakeBackend()
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: 'sonnet',
      env: {},
      idleTimeoutMs: 60_000,
    })
    const bot = makeBot()
    const chat = env.addBot(bot)
    const conversation = env.addBot(bot)
    const sessionId = 'wses_01CCSESSION'
    env.sessions.set(conversation.id, sessionId)
    const started: number[] = []
    const directory: WorkSessionDirectory = {
      get: (id) =>
        id === sessionId
          ? {
              id,
              botId: bot.id,
              conversationId: conversation.id,
              title: 'Refactor login',
              goal: 'Tokens',
              cwd: '/workspace/worktrees/app/ana-ession',
              projectId: null,
              planId: null,
              repoName: 'app',
              branch: 'bot/ana/refactor-login-ession',
              brief: '# Session brief: Refactor login',
            }
          : null,
      state: () => '[ ] Swap the middleware',
      laneStatus: () => undefined,
      cliStarted: () => {
        started.push(started.length)
        return started.length - 1
      },
      recovery: () => '# Where this session stands\nRECOVERY',
      loadTranscript: () => ({ summary: null, entries: [] }),
      appendTranscript: () => -1,
      compactTranscript: () => undefined,
      inputSeq: () => 0,
      setInputSeq: () => undefined,
      subagents: () => undefined,
      ensureReady: async () => undefined,
    }
    env.workSessions = directory
    const laneKey = sessionLaneKey(bot.id, sessionId)
    const append = (i: number) => backend.appendedPrompts[i] ?? ''
    return { backend, env, bot, chat, conversation, laneKey, append, started }
  }

  async function sessionTurn(env: TestEnv, conversationId: string, botId: string, text: string) {
    const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversationId, text))
    await host.idle(botId)
    await host.stop()
  }

  it('runs its own process in the session folder, with the session tools and brief', async () => {
    const { backend, env, bot, conversation, laneKey, append, started } = sessionEnv()
    await sessionTurn(env, conversation.id, bot.id, 'comece')
    const spec = backend.specs[0] as GuestProcSpec
    expect(spec.cwd).toBe('/workspace/worktrees/app/ana-ession')
    expect(spec.label).toBe('claude:ana:csession')
    const argv = spec.argv
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch')
    expect(append(0)).toContain('# Work session')
    expect(append(0)).toContain('# Session brief: Refactor login')
    expect(append(0)).not.toContain('RECOVERY')
    expect([...backend.files.keys()]).toContain('mcp-ana-csession.json')
    expect(backend.sessions.has(laneKey)).toBe(true)
    expect(backend.sessions.has(bot.id)).toBe(false)
    expect(started).toEqual([0])
    const input = backend.stdin.filter(Boolean).at(-1) ?? ''
    expect(input).toContain('Swap the middleware')
  })

  it('adds the AGENTS.md of folders without a CLAUDE.md, which Claude Code reads by itself', async () => {
    const { backend, env, bot, conversation, append } = sessionEnv()
    const wt = '/workspace/worktrees/app/ana-ession'
    env.repoInstructions = fakeRepoInstructions(['/workspace/worktrees/app/ana-ession'], {
      [`${wt}/CLAUDE.md`]: '# Root rules for Claude',
      [`${wt}/AGENTS.md`]: '# Root rules for agents',
    })
    await sessionTurn(env, conversation.id, bot.id, 'comece')
    expect(append(0)).not.toContain('<repository_instructions')

    env.repoInstructions = fakeRepoInstructions([wt], { [`${wt}/AGENTS.md`]: '# Only agents rules' })
    env.setSetting(cliKeys('claude_code').meta(sessionLaneKey(bot.id, 'wses_01CCSESSION')), null)
    await sessionTurn(env, conversation.id, bot.id, 'again')
    expect(backend.specs).toHaveLength(2)
    expect(append(1)).toContain(`<repository_instructions path="${wt}/AGENTS.md"`)
    expect(append(1)).toContain('# Only agents rules')
    expect(append(1).indexOf('<repository_instructions')).toBeGreaterThan(
      append(1).indexOf('# Session brief'),
    )
  })

  it('is not rotated for idleness or size, and a fresh CLI session gets where the work stands', async () => {
    const { backend, env, bot, conversation, laneKey, append } = sessionEnv()
    env.setSetting(cliSettingKeys('claude_code').rotateContextTokens, 1)
    await sessionTurn(env, conversation.id, bot.id, 'comece')
    env.advance(3 * 60 * 60_000)
    await sessionTurn(env, conversation.id, bot.id, 'continue')
    expect(backend.specs[1]?.argv).toContain('--resume')
    expect(env.messages.some((m) => m.kind === 'system_event')).toBe(false)
    expect(env.getSetting<CliSessionMeta | null>(cliKeys('claude_code').meta(laneKey), null)).not.toBeNull()

    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: 'opus',
      env: {},
      idleTimeoutMs: 60_000,
    })
    await sessionTurn(env, conversation.id, bot.id, 'what now?')
    expect(backend.specs[2]?.argv).not.toContain('--resume')
    expect(append(2)).toContain('RECOVERY')
  })

  it('runs a helper in a process of its own for one task, read-only when asked, and drops it after', async () => {
    const { backend, env, bot, laneKey, append } = sessionEnv()
    const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
    await host.start(env)
    const result = await host.runTool(
      bot.id,
      null,
      { id: 'c1', name: 'subagent', arguments: { task: 'Map the login routes', tools: 'read_only' } },
      laneKey,
    )
    await host.idle(bot.id)
    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { text: string }).text).toMatch(/^Helper report:\n\n\S/)
    const spec = backend.specs[0] as GuestProcSpec
    expect(spec.cwd).toBe('/workspace/worktrees/app/ana-ession')
    expect(spec.label).toBe('claude:ana:csession-1')
    expect(spec.argv[spec.argv.indexOf('--tools') + 1]).toBe('Bash,Read,Glob,Grep,WebFetch,WebSearch')
    expect(spec.argv).not.toContain('--resume')
    expect(append(0)).toContain('# Helper task')
    expect(append(0)).toContain('Read-only task')
    expect(append(0)).not.toContain('# Work session\n')
    expect(backend.stdin.filter(Boolean).at(-1)).toContain('Map the login routes')
    // Nothing reaches the session's chat, and the helper's CLI session is gone with its lane.
    expect(env.messages.filter((m) => m.kind === 'text')).toHaveLength(0)
    expect(backend.sessions.get(`${laneKey}:sub:1`) ?? null).toBeNull()
    expect(backend.signals.length).toBeGreaterThan(0)
    await host.stop()
  })
})
