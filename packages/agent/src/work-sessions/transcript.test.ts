import { estimateTokens } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import type { WorkSessionView } from '../environment'
import { DefaultAgentHost } from '../host/agent-host'
import { sessionLaneKey } from '../host/lanes'
import { FakeProvider, type FakeStep } from '../llm/fake'
import type { ChatMessage } from '../llm/messages'
import type { CompletionRequest } from '../llm/provider'
import { messagesTokens } from '../memory/tokens'
import { SESSION_SUMMARY_SYSTEM, SUMMARY_PREFIX } from '../prompts/summaries'
import { makeBot, TestEnv } from '../test-support/env'
import { InMemoryWorkSessions } from '../test-support/work-sessions'
import { compactionCut, renderForSummary, sessionConversation } from './transcript'

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const call = (id: string, output = 'x'): ChatMessage[] => [
  { role: 'assistant', content: [], toolCalls: [{ id, name: 'bash', arguments: { command: 'ls' } }] },
  { role: 'tool', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: output }] },
]

describe('session transcript', () => {
  it('replays the summary first and drops results whose call was compacted', () => {
    const [assistant, result] = call('c1')
    const { conversation, seqs } = sessionConversation({
      summary: 'did things',
      entries: [
        { seq: 7, message: result as ChatMessage },
        { seq: 8, message: user('next') },
        { seq: 9, message: assistant as ChatMessage },
      ],
    })
    expect(seqs).toEqual([-1, 8, 9])
    expect(conversation[0]?.content[0]).toMatchObject({ text: expect.stringContaining(SUMMARY_PREFIX) })
    expect(conversation.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('cuts only before a user or assistant entry, keeping what fits', () => {
    const big = 'y'.repeat(3500)
    const conversation = [user('go'), ...call('a', big), ...call('b', big), ...call('c', big), user('more')]
    const seqs = conversation.map((_, i) => i + 1)
    const cut = compactionCut(conversation, seqs, 2_200) as number
    expect(cut).toBeGreaterThan(0)
    expect(conversation[cut]?.role).not.toBe('tool')
    expect(messagesTokens(conversation.slice(cut))).toBeLessThanOrEqual(2_200)
    // The last exchange alone is over the limit: it is still kept, nothing after it is split.
    const tight = compactionCut(conversation, seqs, 10) as number
    expect(conversation[tight]?.role).toBe('user')
    expect(tight).toBe(conversation.length - 1)
    expect(compactionCut([user('only')], [1], 10)).toBeNull()
  })

  it('renders what to summarize within the summarizer budget', () => {
    const conversation = [user('go'), ...call('a', 'z'.repeat(50_000))]
    const text = renderForSummary(conversation, 1_000)
    expect(estimateTokens(text)).toBeLessThanOrEqual(1_000)
    expect(renderForSummary(conversation)).toContain('CALL bash')
  })
})

class FakeSessions extends InMemoryWorkSessions {
  steps = '[~] Map the routes'

  constructor(session: WorkSessionView) {
    super((id) => (id === session.id ? session : null))
  }

  override state() {
    return this.steps
  }
}

const isSummaryRequest = (request: CompletionRequest) =>
  request.messages[0]?.content.some((p) => p.type === 'text' && p.text === SESSION_SUMMARY_SYSTEM) ?? false

async function sessionHost(options: { calls: number; output: number; contextWindow?: number }) {
  let bashCalls = 0
  const provider = new FakeProvider({
    script: (request): FakeStep => {
      if (isSummaryRequest(request)) return { text: `summary ${bashCalls}` }
      if (bashCalls < options.calls) {
        bashCalls++
        return { toolCalls: [{ name: 'bash', arguments: { command: `step ${bashCalls}` } }] }
      }
      return { text: 'finished' }
    },
  })
  const env = new TestEnv(provider, async () => ({
    content: [{ type: 'text', text: 'o'.repeat(options.output) }],
  }))
  const bot = makeBot()
  env.addBot(bot)
  const conversation = env.addBot(bot)
  const sessionId = 'wses_01CONTEXT'
  env.sessions.set(conversation.id, sessionId)
  const directory = new FakeSessions({
    id: sessionId,
    botId: bot.id,
    conversationId: conversation.id,
    title: 'Refactor login',
    goal: 'Tokens instead of sessions',
    cwd: '/workspace/sessions/ana-1',
    projectId: null,
    planId: null,
    repoName: null,
    branch: null,
    brief: '# Session brief: Refactor login\n\nGoal:\nTokens instead of sessions',
  })
  env.workSessions = directory
  if (options.contextWindow) {
    const resolved = await env.resolveModel()
    env.resolveModel = async () => ({ ...resolved, contextWindow: options.contextWindow })
  }
  const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
  await host.start(env)
  return {
    env,
    host,
    provider,
    directory,
    bot,
    conversation,
    laneKey: sessionLaneKey(bot.id, sessionId),
    reset: () => (bashCalls = 0),
  }
}

describe('session lane context (API providers)', () => {
  it('keeps the brief in the prompt and replays the stored transcript with the new input', async () => {
    const { env, host, provider, directory, bot, conversation, laneKey, reset } = await sessionHost({
      calls: 2,
      output: 100,
    })
    env.appendMessage({
      conversationId: conversation.id,
      authorType: 'system',
      kind: 'card',
      content: 'BRIEF CARD',
      payload: {
        type: 'session_brief',
        sessionId: 'wses_01CONTEXT',
        botId: bot.id,
        title: 'Refactor login',
        goal: 'Tokens',
        planId: null,
        projectId: null,
        repoName: null,
        cwd: null,
      },
    })
    host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'session_start',
      note: 'start now',
    })
    await host.idle()
    const first = provider.requests[0] as CompletionRequest
    const systemText = first.messages[0]?.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    expect(systemText).toContain('# Work session')
    expect(systemText).toContain('# Session brief: Refactor login')
    expect(systemText).toContain('/workspace/sessions/ana-1')
    const input = first.messages[1]?.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? ''
    expect(input).toContain('[~] Map the routes')
    expect(input).toContain('start now')
    expect(input).not.toContain('BRIEF CARD')
    expect(directory.entries.map((e) => e.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(directory.laneStatuses).toContain('working')
    expect(provider.requests.every((r) => r.tools.some((t) => t.name === 'session_finish'))).toBe(true)
    expect(provider.requests.some((r) => r.tools.some((t) => t.name === 'session_start'))).toBe(false)

    reset()
    host.onMessageCreated(env.userMessage(conversation.id, 'also cover the logout'))
    await host.idle()
    const second = provider.requests.at(-1) as CompletionRequest
    // Everything of the first turn (tool calls included), then the new message.
    expect(second.messages.filter((m) => m.role === 'tool').length).toBeGreaterThanOrEqual(2)
    const latest = second.messages.filter((m) => m.role === 'user').at(-1)
    expect(latest?.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')).toContain(
      'also cover the logout',
    )
    expect(directory.inputSeqs.get(laneKey)).toBeGreaterThan(0)
  })

  it('folds the oldest transcript into a rolling summary inside a long turn', async () => {
    // Measure the fixed part (prompt + tools) on a roomy window, then give a session little room above it.
    const probe = await sessionHost({ calls: 0, output: 10 })
    probe.host.enqueueTurn({
      botId: probe.bot.id,
      conversationId: probe.conversation.id,
      trigger: 'session_start',
    })
    await probe.host.idle()
    const request = probe.provider.requests[0] as CompletionRequest
    const fixed =
      messagesTokens([request.messages[0] as ChatMessage]) + estimateTokens(JSON.stringify(request.tools))
    await probe.host.stop()

    const { host, provider, directory, bot, conversation } = await sessionHost({
      calls: 12,
      output: 2_500,
      contextWindow: Math.ceil((fixed + 6_000) / 0.65),
    })
    host.enqueueTurn({ botId: bot.id, conversationId: conversation.id, trigger: 'session_start' })
    await host.idle()
    expect(directory.summaries.length).toBeGreaterThan(0)
    expect(provider.requests.some(isSummaryRequest)).toBe(true)
    const turnRequests = provider.requests.filter((r) => !isSummaryRequest(r))
    expect(turnRequests.at(-1)?.messages.at(-1)).toMatchObject({ role: 'tool' })
    const afterSummary = turnRequests.filter((r) =>
      r.messages[1]?.content.some((p) => p.type === 'text' && p.text.startsWith(SUMMARY_PREFIX)),
    )
    expect(afterSummary.length).toBeGreaterThan(0)
    for (const r of afterSummary) expect(r.messages[2]?.role).not.toBe('tool')
    // The turn never went past the budget by more than one exchange.
    for (const r of turnRequests)
      expect(messagesTokens(r.messages.slice(1))).toBeLessThan(6_000 + 2 * estimateTokens('o'.repeat(2_500)))
    expect(directory.entries.some((e) => e.compacted)).toBe(true)
  })
})
