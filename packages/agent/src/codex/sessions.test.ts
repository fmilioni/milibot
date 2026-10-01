import { describe, expect, it } from 'vitest'

import type { CliLaunch } from '../cli/engine'
import { codexRecorder, FakeCodexBackend, readCodexFixture } from '../test-support/codex'
import { makeBot } from '../test-support/env'
import { describeCodexTool, unwrapShellCommand } from './items'
import { CodexSessions } from './sessions'
import { mergeCodexRateLimits } from './usage'

const bot = makeBot({ slug: 'iris', displayNum: 3 })

function launch(extra: Partial<CliLaunch> = {}): CliLaunch {
  return {
    bot,
    model: 'gpt-6.1-sol',
    tuning: { effort: 'medium' },
    env: { GIT_AUTHOR_NAME: 'Iris' },
    providerConfig: {},
    idleTimeoutMs: 60_000,
    instructions: 'You are Iris.',
    ...extra,
  }
}

describe('CodexSessions', () => {
  it('starts app-server as agent, opens a thread with Milibot MCP and streams a recorded turn', async () => {
    const backend = new FakeCodexBackend()
    const sessions = new CodexSessions(backend)
    const { io, log } = codexRecorder()
    const result = await sessions.runTurn(launch(), 'check the notes', io)

    const spec = backend.specs[0]
    expect(spec?.argv).toEqual(['codex', 'app-server'])
    expect(spec?.user).toBe('agent')
    expect(spec?.env).toMatchObject({
      CODEX_HOME: '/home/agent/.codex',
      MILIBOT_MCP_TOKEN: `tok-${bot.id}-${bot.id}`,
      GIT_AUTHOR_NAME: 'Iris',
    })
    expect(backend.methods()).toEqual(['initialize', 'thread/start', 'turn/start'])
    const start = backend.requests[1]?.params as Record<string, unknown>
    expect(start).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      developerInstructions: 'You are Iris.',
      model: 'gpt-6.1-sol',
    })
    expect(start.config).toMatchObject({
      'features.multi_agent': false,
      model_reasoning_effort: 'medium',
      'mcp_servers.milibot': {
        url: 'http://10.0.2.2:5555/mcp',
        bearer_token_env_var: 'MILIBOT_MCP_TOKEN',
        default_tools_approval_mode: 'approve',
        omit_tools_from: ['code_mode'],
      },
    })
    expect(backend.sessions.get(bot.id)).toBe('thread-1')

    expect(result.ok).toBe(true)
    expect(result.subtype).toBe('completed')
    expect(result.text).toBe('All done.')
    expect(result.requests).toBe(4)
    expect(result.firstContextTokens).toBe(1000)
    expect(result.lastContextTokens).toBe(1400)
    expect(result.usage).toMatchObject({ cachedReadTokens: 40, reasoningTokens: 20, outputTokens: 130 })
    expect(result.launched?.fresh).toBe(true)
    expect(log).toEqual([
      'boundary:',
      'delta:Let me check.',
      'boundary:Let me check.',
      'tool_use',
      'start:codex.exec_command',
      'finish:false',
      'rate:43',
      'tool_use',
      'start:codex.apply_patch',
      'finish:false:added /workspace/demo/new.txt,modified /workspace/demo/notes.txt',
      'rate:-',
      'tool_use',
      'rate:-',
      'boundary:',
      'delta:All ',
      'delta:done.',
      'boundary:All done.',
      'rate:-',
      'boundary:',
    ])
  })

  it('resumes the stored thread in a new process, and starts over when it is gone', async () => {
    const backend = new FakeCodexBackend()
    backend.sessions.set(bot.id, 'thread-old')
    const sessions = new CodexSessions(backend)
    const startups: boolean[] = []
    const withStartup = launch({
      startup: (fresh) => {
        startups.push(fresh)
        return {
          systemAppendix: fresh ? 'MEMORY' : 'OLD MEMORY',
          inputPrefix: fresh ? null : 'news',
          sections: { longTermMemory: 1, summaries: 0, recap: 0 },
        }
      },
    })
    const resumed = await sessions.runTurn(withStartup, 'hi', codexRecorder().io)
    expect(resumed.launched?.fresh).toBe(false)
    const resume = backend.requests.find((r) => r.method === 'thread/resume')
    expect(resume?.params).toMatchObject({
      threadId: 'thread-old',
      developerInstructions: 'You are Iris.\n\nOLD MEMORY',
    })
    const turn = backend.requests.find((r) => r.method === 'turn/start')
    expect((turn?.params.input as Array<{ text: string }>)[0]?.text).toBe('news\n\n---\n\nhi')

    await sessions.rotate(bot.id)
    const gone = new FakeCodexBackend()
    gone.sessions.set(bot.id, 'thread-lost')
    gone.handlers['thread/resume'] = () => ({
      error: { code: -32600, message: 'no rollout found for thread id thread-lost' },
    })
    const fresh = await new CodexSessions(gone).runTurn(withStartup, 'hi', codexRecorder().io)
    expect(gone.methods()).toEqual(['initialize', 'thread/resume', 'thread/start', 'turn/start'])
    expect(fresh.launched?.fresh).toBe(true)
    expect(gone.sessions.get(bot.id)).toBe('thread-1')
    expect(startups).toEqual([false, false, true])
  })

  it('keeps one process per lane and reuses it for the next turn', async () => {
    const backend = new FakeCodexBackend()
    const sessions = new CodexSessions(backend)
    await sessions.runTurn(launch(), 'one', codexRecorder().io)
    await sessions.runTurn(launch(), 'two', codexRecorder().io)
    expect(backend.specs).toHaveLength(1)
    expect(backend.methods()).toEqual(['initialize', 'thread/start', 'turn/start', 'turn/start'])
    await sessions.runTurn(launch({ key: `${bot.id}:internal` }), 'three', codexRecorder().io)
    expect(backend.specs).toHaveLength(2)
    expect(backend.specs[1]?.label).toBe('codex:iris:internal')
    expect(sessions.activeLanes()).toHaveLength(2)
    await sessions.closeBot(bot.id)
    expect(sessions.activeLanes()).toHaveLength(0)
  })

  it('steers a message into the running turn and reports when Codex takes it in', async () => {
    const backend = new FakeCodexBackend()
    const recorded = readCodexFixture('turn-steer.ndjson')
    const split =
      recorded.findIndex(
        (m) => m.method === 'item/started' && JSON.stringify(m).includes('commandExecution'),
      ) + 1
    backend.turnScripts = [recorded.slice(0, split)]
    backend.handlers['turn/steer'] = (req) => {
      setTimeout(() => {
        const threadId = req.params.threadId as string
        const turnId = req.params.expectedTurnId as string
        backend.play(
          req.procId,
          threadId,
          turnId,
          recorded.slice(split),
          req.params.clientUserMessageId as string,
        )
      }, 1)
      return undefined
    }
    const sessions = new CodexSessions(backend)
    const { io, log } = codexRecorder()
    let sent = false
    io.onAcceptingInput = (send) => {
      sent = send('also: say hi')
    }
    const result = await sessions.runTurn(launch(), 'run the slow thing', io)
    expect(sent).toBe(true)
    const steer = backend.requests.find((r) => r.method === 'turn/steer')
    expect(steer?.params).toMatchObject({
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'also: say hi' }],
    })
    expect(log.filter((l) => l === 'taken')).toHaveLength(1)
    expect(log.indexOf('taken')).toBeGreaterThan(log.indexOf('finish:false'))
    expect(result.text).toBe('Answered both.')
    expect(backend.methods().filter((m) => m === 'turn/start')).toHaveLength(1)
  })

  it('answers messages that could not be steered in a follow-up turn', async () => {
    const backend = new FakeCodexBackend()
    backend.handlers['turn/steer'] = () => ({ error: { code: -32600, message: 'no active turn to steer' } })
    const sessions = new CodexSessions(backend)
    const { io, log } = codexRecorder()
    io.onAcceptingInput = (send) => void send('late message')
    await sessions.runTurn(launch(), 'hi', io)
    const turns = backend.requests.filter((r) => r.method === 'turn/start')
    expect(turns).toHaveLength(2)
    expect((turns[1]?.params.input as Array<{ text: string }>)[0]?.text).toBe('late message')
    expect(log).toContain('taken')
  })

  it('interrupts the running turn when the Milibot turn is stopped', async () => {
    const backend = new FakeCodexBackend()
    const script = readCodexFixture('turn-interrupt.ndjson')
    const completed = script.pop() as Record<string, unknown>
    backend.turnScripts = [script]
    backend.handlers['turn/interrupt'] = (req) => {
      setTimeout(() => {
        const params = completed.params as { turn: Record<string, unknown> }
        backend.emit(req.procId, {
          ...completed,
          params: { threadId: req.params.threadId, turn: { ...params.turn, id: req.params.turnId } },
        })
      }, 5)
      return { result: {} }
    }
    const sessions = new CodexSessions(backend)
    const abort = new AbortController()
    const { io, log } = codexRecorder(abort.signal)
    io.onNativeToolStart = (_id, name) => {
      log.push(`start:${name}`)
      abort.abort()
    }
    const result = await sessions.runTurn(launch(), 'run forever', io)
    expect(backend.methods()).toContain('turn/interrupt')
    expect(result.subtype).toBe('interrupted')
    expect(result.ok).toBe(false)
    expect(result.error).toBeNull()
  })

  const fast = { interruptGraceMs: 40, killGraceMs: 40 }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('kills the process when the interrupted turn never completes', async () => {
    const backend = new FakeCodexBackend()
    backend.turnScripts = [[]]
    backend.ignoredSignals.add('SIGTERM')
    const sessions = new CodexSessions(backend, undefined, fast)
    const abort = new AbortController()
    const pending = sessions.runTurn(launch(), 'run forever', codexRecorder(abort.signal).io)
    await wait(10)
    abort.abort()
    expect(await pending).toMatchObject({ subtype: 'interrupted', error: null })
    expect(backend.methods()).toContain('turn/interrupt')
    expect(backend.signals).toEqual(['SIGKILL'])
    expect(sessions.activeLanes()).toEqual([])
  })

  it('kills a closed app-server that does not exit on SIGTERM', async () => {
    const backend = new FakeCodexBackend()
    const sessions = new CodexSessions(backend, undefined, fast)
    await sessions.runTurn(launch(), 'hi', codexRecorder().io)
    await sessions.close(bot.id)
    await wait(80)
    expect(backend.signals).toEqual(['SIGTERM'])

    backend.ignoredSignals.add('SIGTERM')
    await sessions.runTurn(launch(), 'hi', codexRecorder().io)
    await sessions.close(bot.id)
    await wait(80)
    expect(backend.signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL'])
  })

  it('runs read-only lanes in the read-only sandbox, also when the thread resumes', async () => {
    const backend = new FakeCodexBackend()
    const sessions = new CodexSessions(backend)
    await sessions.runTurn(
      launch({ key: `${bot.id}:chat:sub:1`, readOnly: true }),
      'look',
      codexRecorder().io,
    )
    await sessions.runTurn(launch(), 'work', codexRecorder().io)
    const starts = backend.requests.filter((r) => r.method === 'thread/start')
    expect(starts.map((r) => r.params.sandbox)).toEqual(['read-only', 'danger-full-access'])

    await sessions.closeAll()
    await sessions.runTurn(
      launch({ key: `${bot.id}:chat:sub:1`, readOnly: true }),
      'again',
      codexRecorder().io,
    )
    const resume = backend.requests.find((r) => r.method === 'thread/resume')
    expect(resume?.params).toMatchObject({ threadId: 'thread-1', sandbox: 'read-only' })
  })

  it('joins stdout lines the guest split', async () => {
    const backend = new FakeCodexBackend()
    const emit = backend.emit.bind(backend)
    backend.emit = (procId, message) => {
      const line = JSON.stringify(message)
      if (line.length < 200) return emit(procId, message)
      backend.push(procId, { type: 'stdout', data: line.slice(0, 100), partial: true })
      backend.push(procId, { type: 'stdout', data: line.slice(100) })
    }
    const result = await new CodexSessions(backend).runTurn(launch(), 'check the notes', codexRecorder().io)
    expect(result.ok).toBe(true)
    expect(result.text).not.toBe('')
  })

  it('reports failed turns with the error Codex gave', async () => {
    const backend = new FakeCodexBackend()
    backend.turnScripts = [
      readCodexFixture('turn-unauthorized.ndjson'),
      readCodexFixture('turn-usage-limit.ndjson'),
    ]
    const sessions = new CodexSessions(backend)
    const unauthorized = await sessions.runTurn(launch(), 'hi', codexRecorder().io)
    expect(unauthorized.subtype).toBe('failed')
    expect(unauthorized.error?.message).toMatch(/401 Unauthorized/)
    expect(unauthorized.error?.code).toBe('cli_login_required')
    const { io, log } = codexRecorder()
    const limited = await sessions.runTurn(launch(), 'hi', io)
    expect(limited.error?.code).toBe('cli_usage_limit')
    expect(log).toContain('rate:100')
  })

  it('reports a process that exits mid-turn', async () => {
    const backend = new FakeCodexBackend()
    backend.turnScripts = [[]]
    backend.handlers['turn/start'] = (req) => {
      setTimeout(() => backend.push(req.procId, { type: 'exit', code: 1, signal: null }), 5)
      return undefined
    }
    const sessions = new CodexSessions(backend)
    const result = await sessions.runTurn(launch(), 'hi', codexRecorder().io)
    expect(result.subtype).toBe('process_exited')
    expect(result.error?.message).toMatch(/codex exited \(code 1\)/)
    expect(sessions.activeLanes()).toEqual([])
  })

  it('refuses questions to the user and grants approvals the server asks for', async () => {
    const backend = new FakeCodexBackend()
    backend.handlers['turn/start'] = (req) => {
      setTimeout(() => {
        backend.emit(req.procId, { id: 90, method: 'item/tool/requestUserInput', params: {} })
        backend.emit(req.procId, { id: 91, method: 'item/commandExecution/requestApproval', params: {} })
      }, 0)
      return undefined
    }
    await new CodexSessions(backend).runTurn(launch(), 'hi', codexRecorder().io)
    expect(backend.answers).toEqual([
      { id: 90, error: { code: -32601, message: 'item/tool/requestUserInput is not available in Milibot' } },
      { id: 91, result: { decision: 'accept' } },
    ])
  })

  it('runs a one-shot in an ephemeral thread without tools', async () => {
    const backend = new FakeCodexBackend()
    backend.turnScripts = [
      [
        {
          method: 'item/agentMessage/delta',
          params: { threadId: 't', turnId: 'x', itemId: 'm', delta: 'Short ' },
        },
        {
          method: 'item/completed',
          params: {
            threadId: 't',
            turnId: 'x',
            item: { type: 'agentMessage', id: 'm', text: 'Short summary.' },
          },
        },
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 't',
            turnId: 'x',
            tokenUsage: {
              total: {},
              last: {
                totalTokens: 60,
                inputTokens: 50,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 10,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 400_000,
            },
          },
        },
        {
          method: 'turn/completed',
          params: { threadId: 't', turn: { id: 'x', status: 'completed', error: null, durationMs: 12 } },
        },
      ],
    ]
    const deltas: string[] = []
    const result = await new CodexSessions(backend).oneShot({
      bot,
      model: 'gpt-6-luna',
      env: {},
      providerConfig: {},
      effort: 'low',
      systemPrompt: 'Summarize.',
      prompt: 'long text',
      onText: (d) => deltas.push(d),
    })
    expect(result).toMatchObject({ text: 'Short summary.', error: null, durationMs: 12 })
    expect(result.usage?.inputTokens).toBe(50)
    expect(deltas).toEqual(['Short '])
    const start = backend.requests.find((r) => r.method === 'thread/start')
    expect(start?.params).toMatchObject({
      ephemeral: true,
      sandbox: 'read-only',
      developerInstructions: 'Summarize.',
    })
    expect(start?.params.config).toMatchObject({ 'features.shell_tool': false, web_search: 'disabled' })
    expect(backend.signals).toContain('SIGTERM')
  })
})

describe('Codex items', () => {
  it('unwraps the shell Codex runs commands in', () => {
    expect(unwrapShellCommand("/bin/bash -lc 'echo hi && cat notes.txt'")).toBe('echo hi && cat notes.txt')
    expect(unwrapShellCommand("/bin/bash -lc 'echo '\\''quoted'\\'''")).toBe("echo 'quoted'")
    expect(unwrapShellCommand('ls -la')).toBe('ls -la')
  })

  it('shows reads, listings and searches as such', () => {
    expect(
      describeCodexTool('codex.exec_command', {
        command: 'cat notes.txt',
        actions: [
          { type: 'read', command: 'cat notes.txt', name: 'notes.txt', path: '/workspace/demo/notes.txt' },
        ],
      }),
    ).toEqual({ hidden: false, kind: 'file_read', detail: '/workspace/demo/notes.txt' })
    expect(
      describeCodexTool('codex.exec_command', {
        command: 'rg todo src',
        actions: [{ type: 'search', command: 'rg todo src', query: 'todo', path: 'src' }],
      }),
    ).toEqual({ hidden: false, kind: 'search', detail: 'todo in src' })
    expect(describeCodexTool('codex.exec_command', { command: 'true', actions: [] })).toEqual({
      hidden: true,
    })
    expect(describeCodexTool('codex.apply_patch', { files: [{ path: '/w/a.ts', kind: 'add' }] })).toEqual({
      hidden: false,
      kind: 'file_write',
      detail: '/w/a.ts',
    })
  })
})

describe('mergeCodexRateLimits', () => {
  it('keeps windows a sparse update leaves out and flags a full window', () => {
    const first = mergeCodexRateLimits(
      null,
      'prov',
      {
        limitId: 'codex',
        primary: { usedPercent: 43, windowDurationMins: 300, resetsAt: 2_000 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 9_000 },
        planType: 'plus',
        rateLimitReachedType: null,
      },
      1_000_000,
    )
    expect(first).toMatchObject({
      status: 'allowed',
      plan: 'plus',
      windows: [
        { id: 'five_hour', utilization: 0.43, resetsAt: 2_000_000 },
        { id: 'seven_day', utilization: 0.12, resetsAt: 9_000_000 },
      ],
    })
    const sparse = mergeCodexRateLimits(
      first,
      'prov',
      { limitId: 'codex', primary: null, secondary: null, planType: null, rateLimitReachedType: null },
      1_000_500,
    )
    expect(sparse?.windows).toEqual(first?.windows)
    expect(sparse?.plan).toBe('plus')
    const full = mergeCodexRateLimits(
      sparse,
      'prov',
      {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000 },
        secondary: null,
        planType: null,
        rateLimitReachedType: null,
      },
      1_001_000,
    )
    expect(full).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2_000_000 })
  })
})
