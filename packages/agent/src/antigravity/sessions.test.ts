import { describe, expect, it } from 'vitest'

import type { CliLaunch, CliTurnIO } from '../cli/engine'
import { agyLine, FakeAntigravityBackend, readAntigravityFixture } from '../test-support/antigravity'
import { makeBot } from '../test-support/env'
import { antigravityDriver } from '.'
import { antigravityErrorCode } from './config'
import { antigravityGenerateImages } from './images'
import { ANTIGRAVITY_QUOTA_CHECK, antigravityBaseModel, antigravityEffort } from './sessions'
import { parseAntigravityLine } from './stream-json'
import { antigravityMcpCall, describeAntigravityTool } from './tools'
import { parseAntigravityUsage } from './usage'

const bot = makeBot({ slug: 'iris', displayNum: 3 })

function launch(extra: Partial<CliLaunch> = {}): CliLaunch {
  return {
    bot,
    model: null,
    env: {},
    idleTimeoutMs: 60_000,
    instructions: '# Your role\n\nYou are Iris.',
    ...extra,
  }
}

function recorder() {
  const log: string[] = []
  const quota: unknown[] = []
  const io: CliTurnIO = {
    signal: new AbortController().signal,
    onTextDelta: (t) => log.push(`delta:${t.trim()}`),
    onTextBoundary: (t) => log.push(`boundary:${t ?? ''}`),
    onToolUse: () => log.push('tool_use'),
    onNativeToolStart: (_id, name, input) => log.push(`start:${name}:${JSON.stringify(input)}`),
    onNativeToolFinish: (_id, isError, output) => log.push(`finish:${isError}:${output.trim()}`),
    onQuota: (update) => quota.push(update),
  }
  return { io, log, quota }
}

describe('Antigravity stream-json', () => {
  it('reads the usage of a request: cache reads apart, thinking out of the output', () => {
    const event = parseAntigravityLine(agyLine.answer(1, 'hi'))
    expect(event).toMatchObject({
      type: 'step',
      stepType: 'agent_response',
      textDelta: 'hi',
      usage: { inputTokens: 1200, cachedReadTokens: 300, outputTokens: 15, reasoningTokens: 5 },
    })
    expect(parseAntigravityLine('warning: conversation "x" not found')).toBeNull()
  })

  it('maps errors to the card codes', () => {
    expect(antigravityErrorCode('authentication failed or timed out')).toBe('cli_login_required')
    expect(antigravityErrorCode('RESOURCE_EXHAUSTED: quota exceeded')).toBe('cli_usage_limit')
    expect(
      antigravityErrorCode('RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).'),
    ).toBe('cli_error')
    expect(antigravityErrorCode('invalid model selection')).toBe('cli_error')
  })
})

describe('Antigravity models', () => {
  it('reads the base model of a reported one and narrows the effort to its levels', () => {
    expect(antigravityBaseModel('gemini-3.8-flash-low')).toBe('gemini-3.8-flash')
    expect(antigravityBaseModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(antigravityEffort('gemini-3.1-pro', 'medium')).toBe('high')
    expect(antigravityEffort('claude-sonnet-4-6', 'high')).toBeNull()
    expect(antigravityEffort(null, 'xhigh')).toBe('high')
    expect(antigravityEffort('gemini-3.8-flash', null)).toBe('high')
    expect(antigravityEffort(null, null)).toBeNull()
  })
})

describe('Antigravity tools', () => {
  it('logs shell calls as {command} and names its own tools apart', () => {
    expect(describeAntigravityTool('agy.view_file', { AbsolutePath: '/workspace/a.ts' }, {})).toEqual({
      hidden: false,
      kind: 'file_read',
      detail: '/workspace/a.ts',
    })
    expect(describeAntigravityTool('agy.manage_task', {}, {})).toEqual({ hidden: true })
    expect(describeAntigravityTool('Bash', {}, {})).toBeNull()
  })

  it("tells Milibot's tools from an external server's behind the bridge", () => {
    const call = (ServerName: string, ToolName: string) =>
      antigravityMcpCall({
        name: 'call_mcp_tool',
        parameters: { ServerName, ToolName, Arguments: { q: 1 } },
        output: null,
      })
    expect(call('milibot', 'memory_save')).toEqual({ milibot: true })
    expect(call('milibot', 'notion__search')).toEqual({
      milibot: false,
      name: 'mcp__notion__search',
      input: { q: 1 },
    })
    expect(antigravityMcpCall({ name: 'view_file', parameters: {}, output: null })).toBeNull()
  })
})

describe('AntigravitySessions', () => {
  it("runs a lane as its own agent, with Milibot's MCP through the bridge config", async () => {
    const backend = new FakeAntigravityBackend()
    const sessions = antigravityDriver.createSessions(backend)
    await sessions.runTurn(
      launch({
        model: 'gemini-3.1-pro',
        tuning: { effort: 'medium' },
        nativeTools: ['run_command'],
        mcpTools: [
          {
            name: 'memory_save',
            description: 'Saves a note.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
        externalMcp: {
          servers: {
            notes: {
              type: 'stdio',
              command: 'notes-mcp',
              args: [],
              tools: [{ name: 'search', description: 'Searches notes.', inputSchema: {} }],
            },
          },
          disallowedTools: [],
          fingerprint: 'f',
          tokensByServer: {},
        },
      }),
      'hi',
      recorder().io,
    )
    const spec = backend.specs[0]
    expect(spec?.argv).toEqual([
      'agy',
      '--agent',
      'milibot-iris',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--model',
      'gemini-3.1-pro',
      '--effort',
      'high',
      '-p=',
    ])
    expect(spec?.env.MILIBOT_MCP_CONFIG).toBe('/home/agent/.milibot/mcp-agy-iris.json')
    expect(JSON.parse(backend.file('mcp-agy-iris.json') ?? '{}')).toMatchObject({
      servers: {
        notes: { type: 'stdio', command: 'notes-mcp' },
        milibot: {
          type: 'http',
          url: 'http://10.0.2.2:5555/mcp',
          headers: { Authorization: `Bearer tok-${bot.id}-${bot.id}` },
        },
      },
    })
    const agent = backend.file('agy-agents/milibot-iris/agent.md')
    expect(agent).toContain('name: milibot-iris\n')
    expect(agent).toContain(
      '## memory_save\nSaves a note.\nArguments: {"type":"object","properties":{"text":{"type":"string"}}}',
    )
    expect(agent).toContain('## notes__search\nSearches notes.')
    expect(agent).toContain('tools:\n  - run_command\n---\n\n# Your role\n\nYou are Iris.\n\n# MCP tools')
    await sessions.closeAll()
  })

  it('resumes the stored conversation and streams a real tool turn', async () => {
    const backend = new FakeAntigravityBackend()
    const sessions = antigravityDriver.createSessions(backend)
    const first = await sessions.runTurn(launch(), 'hi', recorder().io)
    await sessions.close(bot.id)
    const rec = recorder()
    const second = await sessions.runTurn(launch(), 'again', rec.io)
    expect(backend.specs[1]?.argv).toContain('--conversation')
    expect(second.sessionId).toBe(first.sessionId)
    expect(rec.log).toContain(
      `start:agy.write_to_file:${JSON.stringify({ TargetFile: '/workspace/spike/hello.txt' })}`,
    )
    expect(rec.log).toContain(
      `start:agy.run_command:${JSON.stringify({ command: 'wc -l /workspace/spike/hello.txt' })}`,
    )
    expect(rec.log).toContain('finish:false:2 /workspace/spike/hello.txt')
    expect(rec.log.at(-1)).toBe('boundary:')
    expect(rec.quota).toEqual([ANTIGRAVITY_QUOTA_CHECK])
    expect(second).toMatchObject({ ok: true, text: '2', model: 'gemini-3.8-flash-low', requests: 4 })
    expect(second.usage).toEqual({
      inputTokens: 12332 + 12504 + 12797 + 12947,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 69 + 101 + 65 + 1,
      reasoningTokens: 0,
    })
    expect(second.billing.usage).toMatchObject({ costSource: 'computed' })
    expect(second.lastContextTokens).toBe(12947)
    await sessions.closeAll()
  })

  it("leaves Milibot's MCP calls to its server and reports an external server's", async () => {
    const backend = new FakeAntigravityBackend()
    backend.script = readAntigravityFixture('turn-mcp.ndjson')
    const sessions = antigravityDriver.createSessions(backend)
    const rec = recorder()
    const result = await sessions.runTurn(launch(), 'call it', rec.io)
    expect(result.ok).toBe(true)
    expect(rec.log.filter((l) => l.startsWith('start:'))).toEqual([
      `start:agy.view_file:${JSON.stringify({ AbsolutePath: '/home/agent/.gemini/antigravity-cli/mcp/milibot/lane_echo.json' })}`,
    ])
    expect(rec.log.filter((l) => l === 'tool_use')).toHaveLength(2)
    await sessions.closeAll()
  })

  it('answers a failed turn with its error card code', async () => {
    const backend = new FakeAntigravityBackend()
    backend.script = [
      agyLine.input(0),
      agyLine
        .result('', 'ERROR')
        .replace('"response":""', '"response":"","error":"RESOURCE_EXHAUSTED: weekly limit reached"'),
    ]
    const sessions = antigravityDriver.createSessions(backend)
    const result = await sessions.runTurn(launch(), 'hi', recorder().io)
    expect(result).toMatchObject({
      ok: false,
      subtype: 'error',
      error: { code: 'cli_usage_limit', message: 'RESOURCE_EXHAUSTED: weekly limit reached' },
    })
    await sessions.closeAll()
  })

  it('runs a one-shot as an agent without tools or MCP, prompt on stdin', async () => {
    const backend = new FakeAntigravityBackend()
    backend.scriptFor = (procId) => {
      setTimeout(() => backend.push(procId, { type: 'exit', code: 0, signal: null }), 5)
      return [agyLine.input(0), agyLine.answer(1, 'Short.'), agyLine.result('Short.')]
    }
    const sessions = antigravityDriver.createSessions(backend)
    const result = await sessions.oneShot({
      bot,
      model: null,
      env: {},
      systemPrompt: 'Summarize.',
      prompt: 'long text',
    })
    expect(result).toMatchObject({ text: 'Short.', error: null })
    expect(backend.specs[0]?.argv).toContain('low')
    expect(backend.inputs).toEqual(['long text'])
    const [name, content] = [...backend.files.entries()][0] as [string, string]
    expect(name).toMatch(/^agy-agents\/milibot-iris-summary-[0-9a-f]{8}\/agent\.md$/)
    expect(content).toContain('inheritMcp: false\ntools: []\n')
  })
})

describe('antigravityGenerateImages', () => {
  it('reads the pictures generate_image saved in the conversation folder', async () => {
    const backend = new FakeAntigravityBackend()
    backend.scriptFor = (procId) => {
      setTimeout(() => backend.push(procId, { type: 'exit', code: 0, signal: null }), 5)
      return readAntigravityFixture('turn-image.ndjson')
    }
    const read: Array<[string, string[]]> = []
    const result = await antigravityGenerateImages(backend, {
      bot,
      model: null,
      env: {},
      prompt: 'a fox',
      count: 1,
      aspect: '1:1',
      transparent: false,
      referencePaths: [],
      readImages: async (conversation, names) => {
        read.push([conversation, names])
        return [{ bytes: new Uint8Array([1, 2]), mediaType: 'image/jpeg' }]
      },
    })
    expect(result.images).toHaveLength(1)
    expect(read).toEqual([['conv-1', ['small_red_fox_snow']]])
    expect(backend.specs[0]?.label).toBe('agy-image:iris')
    expect(backend.specs[0]?.argv).toEqual(expect.arrayContaining(['--effort', 'low']))
    expect(backend.file('agy-agents/milibot-iris-draw-image/agent.md')).toContain('  - generate_image')
  })
})

describe('parseAntigravityUsage', () => {
  it('turns the remaining fractions of /usage into used windows', () => {
    const stdout = JSON.stringify({
      status: 'SUCCESS',
      command: {
        data: {
          groups: [
            {
              buckets: [
                { id: 'gemini-weekly', remaining_fraction: 0.75, reset_time: '2026-10-08T20:51:45Z' },
                { id: 'gemini-5h', remaining_fraction: 0, reset_time: '2026-10-02T01:51:45Z' },
              ],
            },
          ],
        },
      },
    })
    const windows = parseAntigravityUsage(stdout)
    expect(windows).toEqual([
      { id: 'seven_day', utilization: 0.25, resetsAt: Date.parse('2026-10-08T20:51:45Z') },
      { id: 'five_hour', utilization: 1, resetsAt: Date.parse('2026-10-02T01:51:45Z') },
    ])
    const usage = antigravityDriver.mergeQuota(null, 'p1', windows, Date.parse('2026-10-01T22:00:00Z'))
    expect(usage).toMatchObject({ engine: 'antigravity', status: 'rejected', rateLimitType: 'five_hour' })
    expect(antigravityDriver.mergeQuota(null, 'p1', ANTIGRAVITY_QUOTA_CHECK, 0)).toBeNull()
    expect(parseAntigravityUsage('Authentication required. Please visit the URL')).toBeNull()
  })
})
