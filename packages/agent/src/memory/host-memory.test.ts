import { describe, expect, it } from 'vitest'

import { DefaultAgentHost } from '../host/agent-host'
import { FakeProvider, type FakeStep } from '../llm/fake'
import type { CompletionRequest } from '../llm/provider'
import { SUMMARY_SYSTEM_PROMPT } from '../prompts/summaries'
import { makeBot, TestEnv } from '../test-support/env'
import { compositionTotal } from './tokens'

const isSummary = (request: CompletionRequest) =>
  request.messages[0]?.content.some((p) => p.type === 'text' && p.text === SUMMARY_SYSTEM_PROMPT) ?? false

function systemText(request: CompletionRequest | undefined): string {
  return (request?.messages[0]?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

async function setup(reply: (request: CompletionRequest, i: number) => FakeStep, memory = {}) {
  const provider = new FakeProvider({
    script: (request, i) => (isSummary(request) ? { text: `SUMMARY-${i}` } : reply(request, i)),
  })
  const env = new TestEnv(provider)
  const bot = makeBot()
  const conversation = env.addBot(bot)
  const host = new DefaultAgentHost({ deltaFlushMs: 1, memory })
  await host.start(env)
  const say = async (text: string) => {
    host.onMessageCreated(env.userMessage(conversation.id, text))
    await host.idle(bot.id)
  }
  return { provider, env, bot, conversation, host, say }
}

describe('agent host memory', () => {
  it('compacts after turns, logs the summary call and sends the summary in later turns', async () => {
    const { provider, env, host, say } = await setup(() => ({ text: `response ${'large '.repeat(150)}` }), {
      tailBudgetTokens: 2000,
      compactThresholdTokens: 2000,
      compactKeepTokens: 1000,
    })
    for (let i = 0; i < 12; i++) await say(`question ${i}: ${'contexts '.repeat(60)}`)

    const summaryCalls = env.llmCalls.filter((c) => c.purpose === 'summary')
    expect(summaryCalls.length).toBeGreaterThan(0)
    expect(summaryCalls[0]).toMatchObject({ botId: expect.any(String), turnId: null, error: null })
    expect(env.memory.summaries.length).toBeGreaterThan(0)
    expect(env.memory.compacted.size).toBeGreaterThan(0)

    const lastTurn = provider.requests.filter((r) => !isSummary(r)).at(-1)
    expect(systemText(lastTurn)).toContain('# Earlier in this conversation')
    expect(systemText(lastTurn)).toMatch(/SUMMARY-\d+/)
    const turnCall = env.llmCalls.filter((c) => c.purpose === 'turn').at(-1)
    const composition = turnCall?.contextComposition
    expect(composition?.summaries).toBeGreaterThan(0)
    expect(composition?.recentTail).toBeGreaterThan(0)
    const sum = composition ? compositionTotal(composition) : 0
    expect(sum).toBe(turnCall?.usage.inputTokens)
    await host.stop()
  })

  it('fits the history to the registered context window of the model', async () => {
    const run = async (contextWindow: number | null) => {
      const { provider, env, host, say } = await setup(() => ({ text: 'ok' }))
      const resolve = env.resolveModel.bind(env)
      env.resolveModel = async (bot) => {
        const resolved = await resolve(bot)
        return resolved.kind === 'native' ? { ...resolved, contextWindow } : resolved
      }
      for (let i = 0; i < 10; i++) await say(`question ${i}: ${'contexts '.repeat(100)}`)
      await host.stop()
      return provider.requests.at(-1)?.messages.filter((m) => m.role === 'user').length ?? 0
    }
    const unknown = await run(null)
    const small = await run(4000)
    expect(unknown).toBe(10)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(unknown)
  })

  it('memory_save persists a note that is in the context of the next turns', async () => {
    const { provider, env, host, say } = await setup((_req, i) =>
      i === 0
        ? { toolCalls: [{ name: 'memory_save', arguments: { note: 'The user goes by Fe.' } }] }
        : { text: 'ok' },
    )
    await say('call me Fe')
    expect(env.memory.pinnedNotes(env.listBots()[0]?.id ?? '').map((n) => n.content)).toEqual([
      'The user goes by Fe.',
    ])
    expect(env.toolLog).toEqual([])
    expect([...env.toolCalls.values()].map((t) => [t.toolName, t.status])).toEqual([['memory_save', 'ok']])
    await say('what is my name?')
    const last = provider.requests.at(-1)
    expect(systemText(last)).toContain('# Long-term memory')
    expect(systemText(last)).toContain('The user goes by Fe.')
    await host.stop()
  })

  it('truncates long tool outputs before they enter the context', async () => {
    const { provider, env, host, say } = await setup((_req, i) =>
      i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'cat big' } }] } : { text: 'ok' },
    )
    env.toolHandler = async () => ({ content: [{ type: 'text', text: `A${'x'.repeat(40_000)}Z` }] })
    await say('leia')
    const tool = provider.requests[1]?.messages.find((m) => m.role === 'tool')
    const text = tool?.content[0]?.type === 'text' ? tool.content[0].text : ''
    expect(text.length).toBeLessThan(13_000)
    expect(text).toContain('characters of output omitted')
    await host.stop()
  })
})
