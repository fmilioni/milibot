import type { ActivityPayload } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { CLI_ENGINE_DRIVERS } from '../cli/registry'
import type { ToolExecContext, TranscriptEntry, WorkSessionDirectory, WorkSessionView } from '../environment'
import { FakeProvider, type FakeStep } from '../llm/fake'
import type { ChatMessage } from '../llm/messages'
import type { CompletionRequest } from '../llm/provider'
import { makeBot, TestEnv } from '../test-support/env'
import { toolsForLane } from '../tools/policy'
import { DefaultAgentHost } from './agent-host'
import { sessionLaneKey } from './lanes'

const SESSION = 'wses_01HELPERS'

const textOf = (message: ChatMessage | undefined) =>
  (message?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')

const isHelper = (request: CompletionRequest) => textOf(request.messages[0]).includes('# Helper task')

class Sessions implements WorkSessionDirectory {
  counts: Array<{ running: number; total: number; ended?: string }> = []
  ready: string[] = []
  private seq = 0
  constructor(private readonly session: WorkSessionView) {}
  get(id: string) {
    return id === this.session.id ? this.session : null
  }
  state() {
    return ''
  }
  laneStatus() {}
  cliStarted() {
    return 0
  }
  recovery() {
    return ''
  }
  loadTranscript(): { summary: string | null; entries: TranscriptEntry[] } {
    return { summary: null, entries: [] }
  }
  appendTranscript() {
    return ++this.seq
  }
  compactTranscript() {}
  inputSeq() {
    return 0
  }
  setInputSeq() {}
  subagents(_id: string, counts: { running: number; total: number }, ended?: string) {
    this.counts.push({ ...counts, ...(ended ? { ended } : {}) })
  }
  async ensureReady(id: string) {
    this.ready.push(id)
  }
}

interface Options {
  /** Helpers the session asks for in its first response. */
  helpers: Array<{ task: string; tools?: 'read_only' | 'all' }>
  settings?: Record<string, unknown>
  maxSubagents?: number
}

async function setup(options: Options) {
  let running = 0
  let peak = 0
  const gates: Array<() => void> = []
  let gated = true
  const provider = new FakeProvider({
    script: (request): FakeStep => {
      const last = request.messages.at(-1)
      if (isHelper(request)) {
        const task = /Your task, from the work session "[^"]+":\n(.+)/.exec(textOf(request.messages[1]))?.[1]
        if (last?.role === 'user')
          return { toolCalls: [{ name: 'bash', arguments: { command: `do ${task}` } }] }
        return { text: `report of ${task}` }
      }
      if (last?.role === 'user')
        return {
          toolCalls: options.helpers.map((h) => ({
            name: 'subagent',
            arguments: { task: h.task, ...(h.tools ? { tools: h.tools } : {}) },
          })),
        }
      return { text: 'session done' }
    },
  })
  const env = new TestEnv(provider)
  Object.assign(env.settings, options.settings ?? {})
  const bot = makeBot()
  env.addBot(bot)
  const conversation = env.addBot(bot)
  env.sessions.set(conversation.id, SESSION)
  const directory = new Sessions({
    id: SESSION,
    botId: bot.id,
    conversationId: conversation.id,
    title: 'Refactor login',
    goal: 'Tokens instead of sessions',
    cwd: '/workspace/sessions/ana-1',
    projectId: null,
    planId: null,
    repoName: null,
    branch: null,
    brief: '# Session brief: Refactor login',
  })
  env.workSessions = directory
  env.toolHandler = async (ctx: ToolExecContext, call) => {
    if (call.name === 'bash' && ctx.laneKey?.includes(':sub:')) {
      running++
      peak = Math.max(peak, running)
      try {
        if (gated)
          await new Promise<void>((resolve, reject) => {
            gates.push(resolve)
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
      } finally {
        running--
      }
    }
    return { content: [{ type: 'text', text: `ran ${call.name}` }] }
  }
  const host = new DefaultAgentHost({
    deltaFlushMs: 1,
    compaction: false,
    ...(options.maxSubagents ? { maxSubagents: options.maxSubagents } : {}),
  })
  await host.start(env)
  const start = () =>
    host.enqueueTurn({ botId: bot.id, conversationId: conversation.id, trigger: 'session_start', note: 'go' })
  const openGates = () => {
    gated = false
    for (const gate of gates.splice(0)) gate()
  }
  return {
    env,
    bot,
    conversation,
    host,
    provider,
    directory,
    start,
    openGates,
    waiting: () => gates.length,
    peak: () => peak,
  }
}

const until = async (check: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('subagent (helpers of a work session)', () => {
  it('runs the helpers of one response at the same time and returns their reports in order', async () => {
    const t = await setup({ helpers: [{ task: 'map the routes' }, { task: 'read the tests' }] })
    t.start()
    await until(() => t.waiting() === 2)
    t.openGates()
    await t.host.idle()
    expect(t.peak()).toBe(2)
    const parent = t.provider.requests.filter((r) => !isHelper(r)).at(-1) as CompletionRequest
    const results = parent.messages.filter((m) => m.role === 'tool').map(textOf)
    expect(results).toEqual([
      'Helper report:\n\nreport of map the routes',
      'Helper report:\n\nreport of read the tests',
    ])
    // Nothing of the helpers reaches the chat: only the session's own reply.
    const texts = t.env.messages.filter((m) => m.kind === 'text').map((m) => m.content)
    expect(texts).toEqual(['session done'])
    const card = t.env.messages.find((m) => m.kind === 'activity')?.payload as ActivityPayload
    expect(card.steps.map((s) => [s.kind, s.detail, s.result])).toEqual([
      ['subtask', 'map the routes', 'report of map the routes'],
      ['subtask', 'read the tests', 'report of read the tests'],
    ])
    // The helpers' own work is logged in the session's conversation, not shown as chat messages.
    const helperCalls = [...t.env.toolCalls.values()].filter((c) => c.toolName === 'bash')
    expect(helperCalls.map((c) => c.conversationId)).toEqual([t.conversation.id, t.conversation.id])
    expect(t.directory.counts.at(-1)).toMatchObject({ running: 0, total: 2 })
    expect(t.directory.counts.filter((c) => c.ended)).toHaveLength(2)
    expect(t.directory.ready.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps at most three helpers of a session running at once', async () => {
    const t = await setup({
      helpers: ['a', 'b', 'c', 'd', 'e'].map((task) => ({ task })),
      settings: { 'agents.max_parallel': 10, 'agents.max_parallel_sessions': 10 },
    })
    t.start()
    await until(() => t.waiting() === 3)
    await new Promise((r) => setTimeout(r, 30))
    expect(t.waiting()).toBe(3)
    t.openGates()
    await t.host.idle()
    expect(t.peak()).toBe(3)
    const parent = t.provider.requests.filter((r) => !isHelper(r)).at(-1) as CompletionRequest
    expect(parent.messages.filter((m) => m.role === 'tool')).toHaveLength(5)
  })

  it('refuses helpers past the per-session limit', async () => {
    const t = await setup({
      helpers: [{ task: 'one' }, { task: 'two' }],
      maxSubagents: 1,
    })
    t.openGates()
    t.start()
    await t.host.idle()
    const parent = t.provider.requests.filter((r) => !isHelper(r)).at(-1) as CompletionRequest
    const results = parent.messages.filter((m) => m.role === 'tool')
    expect(textOf(results[0])).toContain('report of one')
    expect(textOf(results[1])).toContain('already started its 1 helpers')
  })

  it('stopping the session stops its helpers', async () => {
    const t = await setup({ helpers: [{ task: 'slow' }] })
    t.start()
    await until(() => t.waiting() === 1)
    t.host.control(t.bot.id, 'stop', { sessionId: SESSION })
    await t.host.idle()
    const card = t.env.messages.find((m) => m.kind === 'activity')?.payload as ActivityPayload
    expect(card.status).toBe('cancelled')
    expect(t.env.messages.filter((m) => m.kind === 'text')).toHaveLength(0)
    expect(t.host.screenState(t.bot.id).busy).toBe(false)
  })

  it('gives a read-only helper no tools that change files, and no user or helpers of its own', async () => {
    const t = await setup({ helpers: [{ task: 'look', tools: 'read_only' }] })
    t.openGates()
    t.start()
    await t.host.idle()
    const helper = t.provider.requests.find(isHelper) as CompletionRequest
    const names = helper.tools.map((tool) => tool.name)
    expect(names).toContain('grep')
    for (const name of ['file_write', 'file_edit', 'apply_patch', 'subagent', 'ask_user', 'todo_write'])
      expect(names).not.toContain(name)
    expect(textOf(helper.messages[0])).toContain('Read-only task')
    const session = t.provider.requests.find((r) => !isHelper(r)) as CompletionRequest
    expect(session.tools.map((tool) => tool.name)).toContain('subagent')
  })

  it('offers subagent in the chat and in work sessions, never to a helper', () => {
    expect(toolsForLane('main').map((t) => t.name)).toContain('subagent')
    expect(toolsForLane('session').map((t) => t.name)).toContain('subagent')
    expect(toolsForLane('subagent').map((t) => t.name)).not.toContain('subagent')
    expect(
      toolsForLane('session', { native: CLI_ENGINE_DRIVERS.claude_code.nativeInMcp }).map((t) => t.name),
    ).not.toContain('grep')
  })

  it('refuses subagent outside a running turn', async () => {
    const t = await setup({ helpers: [] })
    const result = await t.host.runTool(t.bot.id, null, {
      id: 'c1',
      name: 'subagent',
      arguments: { task: 'x' },
    })
    expect(result.isError).toBe(true)
    expect(sessionLaneKey(t.bot.id, SESSION)).toContain(SESSION)
  })
})

describe('subagent (helpers of the chat)', () => {
  async function chatSetup() {
    const gates: Array<() => void> = []
    const provider = new FakeProvider({
      script: (request): FakeStep => {
        const last = request.messages.at(-1)
        if (isHelper(request)) {
          const task = /Your task, from your conversation with the user:\n(.+)/.exec(
            textOf(request.messages[1]),
          )?.[1]
          if (last?.role === 'user')
            return { toolCalls: [{ name: 'bash', arguments: { command: `grep ${task}` } }] }
          return { text: `report of ${task}` }
        }
        if (last?.role === 'user')
          return {
            toolCalls: [
              { name: 'subagent', arguments: { task: 'map the routes', tools: 'all' } },
              { name: 'subagent', arguments: { task: 'map the tests' } },
            ],
          }
        return { text: 'plan ready' }
      },
    })
    const env = new TestEnv(provider)
    const bot = makeBot()
    const chat = env.addBot(bot)
    const lanes: string[] = []
    env.toolHandler = async (ctx: ToolExecContext, call) => {
      if (call.name === 'bash') {
        lanes.push(ctx.laneKey ?? '')
        await new Promise<void>((resolve, reject) => {
          gates.push(resolve)
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return { content: [{ type: 'text', text: `ran ${call.name}` }] }
    }
    const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
    await host.start(env)
    host.onMessageCreated(env.userMessage(chat.id, 'plan the change'))
    return { env, bot, chat, host, provider, lanes, gates }
  }

  it('investigates in read-only helpers running in parallel and posts only the reply', async () => {
    const t = await chatSetup()
    await until(() => t.gates.length === 2)
    for (const gate of t.gates.splice(0)) gate()
    await t.host.idle()
    expect(t.lanes.every((key) => key.startsWith(`${t.bot.id}:chat:sub:`))).toBe(true)
    const helper = t.provider.requests.find(isHelper) as CompletionRequest
    const names = helper.tools.map((tool) => tool.name)
    for (const name of ['file_write', 'file_edit', 'apply_patch', 'subagent', 'ask_user'])
      expect(names).not.toContain(name)
    expect(textOf(helper.messages[0])).toContain('Read-only task')
    const parent = t.provider.requests.filter((r) => !isHelper(r)).at(-1) as CompletionRequest
    expect(parent.messages.filter((m) => m.role === 'tool').map(textOf)).toEqual([
      'Helper report:\n\nreport of map the routes',
      'Helper report:\n\nreport of map the tests',
    ])
    const replies = t.env.messages.filter((m) => m.kind === 'text' && m.authorType === 'bot')
    expect(replies.map((m) => m.content)).toEqual(['plan ready'])
  })

  it('refuses what a read-only helper was not given, even through a direct call', async () => {
    const t = await chatSetup()
    await until(() => t.gates.length === 2)
    const lane = t.lanes[0] as string
    expect(t.host.isReadOnlyLane(lane)).toBe(true)
    expect(t.host.isReadOnlyLane(t.bot.id)).toBe(false)
    const result = await t.host.runTool(
      t.bot.id,
      t.chat.id,
      { id: 'c1', name: 'knowledge_write', arguments: { title: 'Notes', content: 'x' } },
      lane,
    )
    expect(result.isError).toBe(true)
    expect(textOf({ role: 'user', content: result.content })).toContain('not available in a read-only task')
    const helper = t.provider.requests.find(isHelper) as CompletionRequest
    const names = helper.tools.map((tool) => tool.name)
    for (const name of ['computer', 'create_bot', 'update_own_prompt', 'knowledge_write', 'routine_create'])
      expect(names).not.toContain(name)
    for (const gate of t.gates.splice(0)) gate()
    await t.host.idle()
    expect(t.host.isReadOnlyLane(lane)).toBe(false)
  })

  it('stopping the chat stops its helpers', async () => {
    const t = await chatSetup()
    await until(() => t.gates.length === 2)
    t.host.control(t.bot.id, 'stop', { scope: 'chat' })
    await t.host.idle()
    const card = t.env.messages.find((m) => m.kind === 'activity')?.payload as ActivityPayload
    expect(card.status).toBe('cancelled')
    expect(t.host.screenState(t.bot.id).busy).toBe(false)
  })
})
