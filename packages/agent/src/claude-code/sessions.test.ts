import { cliSettingKeys } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import type { GuestCliBackend, GuestProcEvent, GuestProcSpec } from '../cli/backend'
import { DefaultAgentHost } from '../host/agent-host'
import { FakeProvider } from '../llm/fake'
import { COMPACT_SYSTEM_PROMPT } from '../prompts/lanes'
import { FakeBackend, readFixture, recorder, turnFixture } from '../test-support/claude-code'
import { makeBot, TestEnv } from '../test-support/env'
import { claudeCodeErrorCode } from './config'
import { ClaudeCodeSessions, claudeCodeTuningEnv, claudeCodeUsage, turnCost } from './sessions'
import {
  type ClaudeCodeEvent,
  type ClaudeRateLimit,
  modelUsageDelta,
  parseStreamJsonLine,
} from './stream-json'

const realTwoTurns = readFixture('two-turns-haiku.ndjson')

describe('ClaudeCodeSessions', () => {
  const bot = makeBot({ slug: 'ana', displayNum: 3 })
  const launch = {
    bot,
    model: 'claude-sonnet-5',
    env: {},
    idleTimeoutMs: 60_000,
    instructions: 'rules',
  }

  it('launches claude -p in the VM and maps a turn into callbacks and usage', async () => {
    const backend = new FakeBackend()
    const sessions = new ClaudeCodeSessions(backend)
    const { io, log } = recorder()
    const result = await sessions.runTurn(launch, 'list the files', io)

    const spec = backend.specs[0] as GuestProcSpec
    expect(spec).toMatchObject({ user: 'agent', cwd: '/workspace', display: 3 })
    expect(spec.env).toMatchObject({ ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1' })
    expect(spec.argv).toContain('--include-partial-messages')
    expect(spec.argv.slice(0, 2)).toEqual(['claude', '-p'])
    expect(spec.argv).toEqual(
      expect.arrayContaining([
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ]),
    )
    expect(spec.argv).toContain('--dangerously-skip-permissions')
    expect(spec.argv[spec.argv.indexOf('--mcp-config') + 1]).toBe('/home/agent/.milibot/mcp-ana.json')
    expect(spec.argv[spec.argv.indexOf('--model') + 1]).toBe('claude-sonnet-5')
    expect(spec.argv).not.toContain('--resume')
    expect(JSON.parse(backend.files.get('mcp-ana.json') as string)).toEqual({
      mcpServers: {
        milibot: {
          type: 'http',
          url: 'http://10.0.2.2:5555/mcp',
          headers: { Authorization: `Bearer tok-${bot.id}` },
        },
      },
    })
    expect(JSON.parse(backend.stdin[0] as string).message.content[0].text).toBe('list the files')

    expect(log).toEqual([
      'mcp:true',
      'boundary:',
      'delta:Listing ',
      'delta:the files.',
      'boundary:Listing the files.',
      'boundary:',
      'start:Bash:toolu_bash1',
      'finish:toolu_bash1:false',
      'boundary:',
      'boundary:',
      'finish:toolu_mcp1:false',
      'boundary:',
      'delta:The folder is empty.',
      'boundary:The folder is empty.',
      'boundary:',
    ])
    expect(result).toMatchObject({
      ok: true,
      subtype: 'success',
      text: 'The folder is empty.',
      sessionId: '8f3c2a1e-0000-4000-8000-000000000001',
    })
    expect(result.billing.usage).toMatchObject({ costUsd: 0.0421, costSource: 'provider' })
    expect(backend.getSessionId(bot.id)).toBe('8f3c2a1e-0000-4000-8000-000000000001')

    // Same process for the next turn.
    await sessions.runTurn(launch, 'again', recorder().io)
    expect(backend.specs).toHaveLength(1)
    await sessions.closeAll()
  })

  it('reports the accumulated input of each streamed tool call', async () => {
    const backend = new FakeBackend()
    const stream = (e: unknown) =>
      JSON.stringify({ type: 'stream_event', event: e, parent_tool_use_id: null })
    const inputDelta = (index: number, partial: string) =>
      stream({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partial },
      })
    backend.script = [
      turnFixture[0] as string,
      stream({ type: 'message_start', message: { id: 'm1' } }),
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'mcp__milibot__design_write_frame' },
      }),
      inputDelta(0, '{"design":'),
      inputDelta(0, '"d1","html":"<di'),
      stream({ type: 'content_block_stop', index: 0 }),
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_b', name: 'Bash' },
      }),
      inputDelta(1, '{"command":"ls"}'),
      inputDelta(0, 'ignored after stop'),
      turnFixture.at(-1) as string,
    ]
    const sessions = new ClaudeCodeSessions(backend)
    const { io } = recorder()
    const drafts: Array<[string, string, string]> = []
    io.onToolInputDelta = (id, name, json) => drafts.push([id, name, json])
    const result = await sessions.runTurn(launch, 'desenhe', io)
    expect(drafts).toEqual([
      ['toolu_a', 'mcp__milibot__design_write_frame', '{"design":'],
      ['toolu_a', 'mcp__milibot__design_write_frame', '{"design":"d1","html":"<di'],
      ['toolu_b', 'Bash', '{"command":"ls"}'],
    ])
    expect(result.events.some((e) => (e as { type: string }).type.startsWith('tool_input'))).toBe(false)
    await sessions.closeAll()
  })

  it('resumes the stored session after the process was closed', async () => {
    const backend = new FakeBackend()
    backend.setSessionId(bot.id, 'previous-session')
    const sessions = new ClaudeCodeSessions(backend)
    await sessions.runTurn(launch, 'hi', recorder().io)
    const argv = backend.specs[0]?.argv ?? []
    expect(argv[argv.indexOf('--resume') + 1]).toBe('previous-session')
    await sessions.close(bot.id)
    expect(backend.signals).toContain('SIGTERM')
    await sessions.runTurn(launch, 'hi again', recorder().io)
    expect(backend.specs).toHaveLength(2)
    expect(backend.specs[1]?.argv).toContain('8f3c2a1e-0000-4000-8000-000000000001')
    await sessions.closeAll()
  })

  it('interrupts the process when the turn is stopped', async () => {
    const backend = new FakeBackend()
    backend.script = turnFixture.slice(0, 5)
    const sessions = new ClaudeCodeSessions(backend)
    const abort = new AbortController()
    const pending = sessions.runTurn(launch, 'long task', recorder(abort.signal).io)
    await new Promise((r) => setTimeout(r, 20))
    abort.abort()
    const result = await pending
    expect(backend.signals).toContain('SIGINT')
    expect(result).toMatchObject({ ok: false, subtype: 'interrupted', error: null })
  })

  it('reports a process that exits without a result', async () => {
    const backend = new FakeBackend()
    backend.script = []
    const sessions = new ClaudeCodeSessions(backend)
    const pending = sessions.runTurn(launch, 'hi', recorder().io)
    await new Promise((r) => setTimeout(r, 10))
    await backend.signal('proc-1', 'SIGTERM')
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/claude exited \(code 130/)
  })

  const fast = { interruptGraceMs: 40, killGraceMs: 40 }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('joins stdout lines the guest split, so a long result still ends the turn', async () => {
    const backend = new FakeBackend()
    backend.splitLinesOver = 64
    const sessions = new ClaudeCodeSessions(backend)
    const result = await sessions.runTurn(launch, 'list the files', recorder().io)
    expect(result).toMatchObject({ ok: true, text: 'The folder is empty.' })
    expect(result.billing.usage.costUsd).toBe(0.0421)
    await sessions.closeAll()
  })

  it('passes the appended system prompt in a private file, not in argv', async () => {
    const backend = new FakeBackend()
    const sessions = new ClaudeCodeSessions(backend)
    await sessions.runTurn({ ...launch, instructions: 'secret persona' }, 'hi', recorder().io)
    const argv = backend.specs[0]?.argv ?? []
    expect(argv.join(' ')).not.toContain('secret persona')
    expect(argv[argv.indexOf('--append-system-prompt-file') + 1]).toBe('/home/agent/.milibot/prompt-ana.md')
    expect(backend.appendedPrompts[0]).toBe('secret persona')
    await sessions.closeAll()
  })

  it('kills a process that ignores the interrupt and keeps streaming', async () => {
    const backend = new FakeBackend()
    backend.script = turnFixture.slice(0, 3)
    backend.ignoredSignals.add('SIGINT')
    const sessions = new ClaudeCodeSessions(backend, undefined, fast)
    const abort = new AbortController()
    const pending = sessions.runTurn(launch, 'long task', recorder(abort.signal).io)
    await wait(10)
    const delta = turnFixture.find((l) => l.includes('text_delta')) as string
    const streaming = setInterval(() => backend.emitLine('proc-1', delta), 5)
    abort.abort()
    const result = await pending
    clearInterval(streaming)
    expect(result).toMatchObject({ ok: false, subtype: 'interrupted', error: null })
    expect(backend.signals).toEqual(['SIGINT', 'SIGKILL'])
    expect(sessions.activeLanes()).toEqual([])
  })

  it('ends the turn when a stop arrives while the process is silent and ignores it', async () => {
    const backend = new FakeBackend()
    backend.script = turnFixture.slice(0, 3)
    backend.ignoredSignals.add('SIGINT')
    const sessions = new ClaudeCodeSessions(backend, undefined, fast)
    const abort = new AbortController()
    const pending = sessions.runTurn(launch, 'long task', recorder(abort.signal).io)
    await wait(10)
    abort.abort()
    expect(await pending).toMatchObject({ subtype: 'interrupted' })
    expect(backend.signals).toContain('SIGKILL')
  })

  it('kills a closed process that does not exit on SIGTERM, and only that one', async () => {
    const backend = new FakeBackend()
    const sessions = new ClaudeCodeSessions(backend, undefined, fast)
    await sessions.runTurn(launch, 'hi', recorder().io)
    await sessions.close(bot.id)
    await wait(80)
    expect(backend.signals).toEqual(['SIGTERM'])

    backend.ignoredSignals.add('SIGTERM')
    await sessions.runTurn(launch, 'hi again', recorder().io)
    await sessions.close(bot.id)
    expect(backend.signals).toEqual(['SIGTERM', 'SIGTERM'])
    await wait(80)
    expect(backend.signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL'])
  })

  it('reports a process that could not start as a failed turn', async () => {
    const backend = new FakeBackend()
    backend.writeAgentFile = async () => {
      throw new Error('VM_UNAVAILABLE')
    }
    const result = await new ClaudeCodeSessions(backend).runTurn(launch, 'hi', recorder().io)
    expect(result).toMatchObject({ ok: false, subtype: 'error', launched: null })
    expect(result.error).toMatchObject({
      code: 'cli_error',
      message: expect.stringMatching(/claude did not start: VM_UNAVAILABLE/),
    })
    expect(backend.specs).toHaveLength(0)
  })

  it('flags a turn the subscription refused', async () => {
    const backend = new FakeBackend()
    backend.script = [
      ...turnFixture.slice(0, 1),
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "You've hit your limit · resets 7pm",
        session_id: '8f3c2a1e-0000-4000-8000-000000000001',
      }),
    ]
    const sessions = new ClaudeCodeSessions(backend)
    const result = await sessions.runTurn(launch, 'hi', recorder().io)
    expect(result).toMatchObject({ ok: false, error: { code: 'cli_usage_limit' } })
    await sessions.closeAll()
  })
})

describe('claudeCodeErrorCode', () => {
  it('maps login, usage limit and other failures', () => {
    expect(claudeCodeErrorCode('Not logged in · Please run /login', false)).toBe('cli_login_required')
    expect(claudeCodeErrorCode('Invalid API key', false)).toBe('cli_login_required')
    expect(claudeCodeErrorCode('Claude AI usage limit reached|1760000000', false)).toBe('cli_usage_limit')
    expect(claudeCodeErrorCode('API Error: 429', true)).toBe('cli_usage_limit')
    expect(claudeCodeErrorCode('claude did not start: VM_UNAVAILABLE', false)).toBe('cli_error')
  })
})

describe('ClaudeCodeSessions.oneShot', () => {
  const bot = makeBot({ slug: 'ana', displayNum: 3 })

  function backendWith(stdout: Array<{ data: string; partial?: boolean }>) {
    const specs: GuestProcSpec[] = []
    const backend = {
      startProcess: async (spec: GuestProcSpec) => {
        specs.push(spec)
        return { id: 'p1' }
      },
      writeStdin: async () => undefined,
      signal: async () => undefined,
      async *events(): AsyncIterable<GuestProcEvent> {
        let seq = 0
        for (const line of stdout) yield { seq: ++seq, type: 'stdout', ...line }
        yield { seq: seq + 1, type: 'exit', code: 0, signal: null }
      },
    } as unknown as GuestCliBackend
    return { backend, specs }
  }

  const textDelta = (text: string) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      parent_tool_use_id: null,
    })

  it('streams the answer with stream-json and joins a line the guest split', async () => {
    const result = turnFixture.at(-1) as string
    const { backend, specs } = backendWith([
      { data: textDelta('<svg ') },
      { data: textDelta('/>') },
      { data: result.slice(0, 40), partial: true },
      { data: result.slice(40) },
    ])
    const deltas: string[] = []
    const out = await new ClaudeCodeSessions(backend).oneShot({
      bot,
      model: null,
      env: {},
      effort: 'high',
      maxOutputTokens: 32_000,
      label: 'draw',
      systemPrompt: 'draw',
      prompt: 'a fox',
      onText: (d) => deltas.push(d),
    })
    expect(deltas).toEqual(['<svg ', '/>'])
    expect(out).toMatchObject({ error: null, text: 'The folder is empty.' })
    expect(out.billing.usage.costUsd).toBe(0.0421)
    const spec = specs[0] as GuestProcSpec
    expect(spec.argv).toEqual(
      expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--include-partial-messages']),
    )
    expect(spec.label).toBe('claude-draw:ana')
    expect(spec.env).toMatchObject({
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
    })
  })

  it('reads the single json result when nothing streams', async () => {
    const { backend, specs } = backendWith([{ data: turnFixture.at(-1) as string }])
    const out = await new ClaudeCodeSessions(backend).oneShot({
      bot,
      model: null,
      env: {},
      systemPrompt: 'sum up',
      prompt: 'text',
    })
    expect(out.text).toBe('The folder is empty.')
    expect(specs[0]?.argv).toEqual(expect.arrayContaining(['--output-format', 'json']))
    expect(specs[0]?.argv).not.toContain('--include-partial-messages')
    expect(specs[0]?.label).toBe('claude-summary:ana')
  })
})

describe('real claude -p output', () => {
  it('treats Claude Code synthetic errors (not logged in) as errors, not model text', async () => {
    const lines = readFixture('not-logged-in.ndjson')
    const events = lines.map(parseStreamJsonLine)
    expect(events[1]).toMatchObject({
      type: 'assistant',
      synthetic: true,
      text: 'Not logged in · Please run /login',
    })
    expect(events[2]).toMatchObject({ type: 'result', isError: true, costUsd: 0 })

    const backend = new FakeBackend()
    backend.script = lines
    const sessions = new ClaudeCodeSessions(backend)
    const { io, log } = recorder()
    const result = await sessions.runTurn(
      { bot: makeBot(), model: null, env: {}, idleTimeoutMs: 60_000, instructions: '' },
      'hi',
      io,
    )
    expect(log.filter((l) => l.startsWith('boundary:Not logged'))).toEqual([])
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'cli_login_required', message: 'Not logged in · Please run /login' },
    })
    await sessions.closeAll()
  })
})

describe('turnCost', () => {
  const result = (costUsd: number, cumulative: number): Extract<ClaudeCodeEvent, { type: 'result' }> => ({
    type: 'result',
    subtype: 'success',
    isError: false,
    text: '',
    sessionId: 's',
    costUsd,
    durationMs: null,
    numTurns: 1,
    usage: {
      inputTokens: 10,
      cachedReadTokens: 30_000,
      cacheWriteTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 0,
    },
    modelUsage: [
      {
        model: 'claude-opus-5-5',
        inputTokens: 10 * cumulative,
        cachedReadTokens: 30_000 * cumulative,
        cacheWriteTokens: 1000 * cumulative,
        outputTokens: 200 * cumulative,
        reasoningTokens: 0,
        costUsd,
        webSearchRequests: 0,
      },
    ],
    errors: [],
  })

  it('takes the first report of a fresh process as is', () => {
    expect(turnCost(result(0.0164, 1), null, 'claude-opus-5-5').costUsd).toBe(0.0164)
  })

  it('prices the first turn from its tokens when Claude Code restored a session total', () => {
    const { costUsd, modelUsage } = turnCost(result(0.43, 20), null, 'claude-opus-5-5')
    // opus 5.5: 4 in, 0.2 cache read, 8 cache write (1 h), 20 out per 1M tokens
    expect(costUsd).toBeCloseTo((10 * 4 + 30_000 * 0.2 + 1000 * 8 + 200 * 20) / 1e6, 10)
    expect(modelUsage).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', cachedReadTokens: 30_000 }),
    ])
  })

  it('subtracts the previous report on later turns of the process', () => {
    const previous = { costUsd: 0.4, models: result(0.4, 19).modelUsage }
    expect(turnCost(result(0.43, 20), previous, null).costUsd).toBeCloseTo(0.03, 10)
  })
})

describe('claudeCodeUsage', () => {
  const usage = {
    inputTokens: 5,
    cachedReadTokens: 6,
    cacheWriteTokens: 7,
    outputTokens: 8,
    reasoningTokens: 0,
  }
  const model = (name: string, inputTokens: number) => ({
    ...usage,
    inputTokens,
    model: name,
    costUsd: 0.01,
    webSearchRequests: 0,
  })

  it('sums the models Claude Code reports and keeps them', () => {
    const models = [model('claude-opus-5-5', 10), model('claude-haiku-5', 20)]
    expect(claudeCodeUsage({ usage, modelUsage: models, costUsd: 0.02 })).toEqual({
      usage: {
        ...usage,
        inputTokens: 30,
        cachedReadTokens: 12,
        cacheWriteTokens: 14,
        outputTokens: 16,
        costUsd: 0.02,
        costSource: 'provider',
      },
      models,
    })
  })

  it('falls back to the call usage, or zeros, without a cost', () => {
    expect(claudeCodeUsage({ usage, modelUsage: [], costUsd: null })).toEqual({
      usage: { ...usage, costUsd: null, costSource: 'unknown' },
    })
    expect(claudeCodeUsage({ usage: null, modelUsage: [], costUsd: null }).usage.inputTokens).toBe(0)
  })
})

describe('Claude Code cost per model', () => {
  it('parses modelUsage of the real CLI, splitting thinking out of output', () => {
    const results = realTwoTurns
      .map(parseStreamJsonLine)
      .filter((e): e is Extract<ClaudeCodeEvent, { type: 'result' }> => e?.type === 'result')
    expect(results).toHaveLength(2)
    expect(results[0]?.modelUsage).toEqual([
      {
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 10,
        cachedReadTokens: 0,
        cacheWriteTokens: 6507,
        outputTokens: 8,
        reasoningTokens: 52,
        costUsd: 0.013323999999999999,
        webSearchRequests: 0,
      },
    ])
    expect(results[0]?.usage).toEqual({
      inputTokens: 10,
      cachedReadTokens: 0,
      cacheWriteTokens: 6507,
      outputTokens: 8,
      reasoningTokens: 52,
    })
    // The second result is cumulative for the process (both turns), unlike `usage`.
    expect(results[1]?.modelUsage[0]).toMatchObject({ inputTokens: 20, cacheWriteTokens: 6613 })
    expect(results[1]?.usage).toMatchObject({ cachedReadTokens: 6507, cacheWriteTokens: 106 })
    const assistant = realTwoTurns
      .map(parseStreamJsonLine)
      .filter((e): e is Extract<ClaudeCodeEvent, { type: 'assistant' }> => e?.type === 'assistant')
    expect(assistant.at(-1)?.contextTokens).toBe(10 + 106 + 6507)
  })

  it('computes per-turn cost and model usage from the cumulative reports of one process', () => {
    const models = (cost: number, input: number) => [
      {
        model: 'a',
        inputTokens: input,
        cachedReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        costUsd: cost,
        webSearchRequests: 0,
      },
    ]
    expect(modelUsageDelta(models(0.3, 30), models(0.1, 10))).toEqual([
      { ...models(0.3, 30)[0], inputTokens: 20, outputTokens: 0, costUsd: expect.closeTo(0.2, 10) },
    ])
    expect(modelUsageDelta(models(0.1, 10), models(0.1, 10))).toEqual([])
  })

  it('records only the turn delta of total_cost_usd and modelUsage across turns of one process', async () => {
    const backend = new FakeBackend()
    let turn = 0
    const turns = [realTwoTurns.slice(0, 5), realTwoTurns.slice(5)]
    backend.scriptFor = () => turns[turn++] ?? []
    const sessions = new ClaudeCodeSessions(backend)
    const launch = { bot: makeBot(), model: 'haiku', env: {}, idleTimeoutMs: 60_000, instructions: '' }
    const first = await sessions.runTurn(launch, 'Say hi in one word.', recorder().io)
    const second = await sessions.runTurn(launch, 'Now say bye in one word.', recorder().io)
    expect(backend.specs).toHaveLength(1)
    expect(first).toMatchObject({ requests: 1, model: 'claude-haiku-4-5-20251001' })
    expect(first.billing.usage.costUsd).toBe(0.013323999999999999)
    expect(second.billing.usage.costUsd).toBeCloseTo(0.0144567 - 0.013323999999999999, 10)
    expect(second.billing.models).toEqual([
      expect.objectContaining({ inputTokens: 10, cachedReadTokens: 6507, cacheWriteTokens: 106 }),
    ])
    expect(second).toMatchObject({ requests: 1, firstContextTokens: 6623, lastContextTokens: 6623 })
    await sessions.closeAll()
  })

  it('passes the slim tool set and the compact system prompt to claude', async () => {
    const env = new TestEnv(new FakeProvider({ script: [] }))
    const backend = new FakeBackend()
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
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    const argv = backend.specs[0]?.argv ?? []
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Bash,Read,Edit,Write,WebFetch,WebSearch')
    expect(argv[argv.indexOf('--system-prompt') + 1]).toBe(COMPACT_SYSTEM_PROMPT)
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet')
    const call = env.llmCalls.at(-1)
    expect(call).toMatchObject({
      model: 'claude-sonnet-5',
      models: [expect.objectContaining({ model: 'claude-sonnet-5' })],
    })
    expect(call?.usage).toMatchObject({ costUsd: 0.0421, costSource: 'provider' })
    await host.stop()

    env.setSetting(cliSettingKeys('claude_code').compactSystemPrompt, false)
    const host2 = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host2.start(env)
    host2.onMessageCreated(env.userMessage(conversation.id, 'again'))
    await host2.idle(bot.id)
    // Another profile: the stored session is dropped (it snapshotted the other system prompt).
    expect(backend.specs[1]?.argv).not.toContain('--system-prompt')
    expect(backend.specs[1]?.argv).not.toContain('--resume')
    expect(env.messages.some((m) => m.kind === 'system_event')).toBe(false)
    await host2.stop()
  })
})

describe('Claude Code subscription usage', () => {
  it('parses rate_limit_event of the real CLI and hands it to the environment', async () => {
    const event = realTwoTurns.map(parseStreamJsonLine).find((e) => e?.type === 'rate_limit')
    expect(event).toEqual({
      type: 'rate_limit',
      info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: 1790460000_000,
        windows: [
          { id: 'five_hour', utilization: 0.12, resetsAt: 1790460000_000 },
          { id: 'seven_day', utilization: 0.21, resetsAt: 1790949600_000 },
        ],
      },
    })

    const backend = new FakeBackend()
    backend.script = realTwoTurns.slice(0, 5)
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: backend }
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: 'haiku',
      env: {},
      idleTimeoutMs: 60_000,
    })
    const seen: unknown[] = []
    env.cliQuota = (providerId, engine, info) =>
      seen.push([providerId, engine, (info as ClaudeRateLimit).windows.length])
    const bot = makeBot()
    const conversation = env.addBot(bot)
    const host = new DefaultAgentHost({ deltaFlushMs: 1 })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    expect(seen).toEqual([['prv_cc', 'claude_code', 2]])
    await host.stop()
  })
})

describe('claudeCodeTuningEnv', () => {
  it('carries effort, output cap and context limit into the CLI environment', () => {
    expect(claudeCodeTuningEnv({})).toEqual({})
    expect(claudeCodeTuningEnv({ effort: 'high', maxOutputTokens: 32_000, contextLimit: 500_000 })).toEqual({
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000',
    })
    expect(claudeCodeTuningEnv({ contextLimit: 150_000 })).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    })
  })
})
