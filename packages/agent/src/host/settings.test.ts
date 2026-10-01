import { describe, expect, it } from 'vitest'

import type { AgentEnvironment, ResolvedModel } from '../environment'
import { FakeProvider, type FakeStep } from '../llm/fake'
import { formatSkillCatalog } from '../prompts/skill-catalog'
import { createTestEnv, makeBot, type TestEnv } from '../test-support/env'
import { TOOL_FAMILY_NAMES } from '../tools/policy'
import { DefaultAgentHost } from './agent-host'
import { agentSettings, positiveInt } from './settings'

async function setup(script: FakeStep[], hooks: Partial<AgentEnvironment> = {}) {
  const provider = new FakeProvider({ script })
  const env = createTestEnv(provider, hooks)
  const bot = makeBot()
  const conversation = env.addBot(bot)
  const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
  await host.start(env)
  const say = (text: string) => host.onMessageCreated(env.userMessage(conversation.id, text))
  return { provider, env, bot, host, say }
}

const botTexts = (env: TestEnv) =>
  env.messages.filter((m) => m.kind === 'text' && m.authorType === 'bot').map((m) => m.content)
const errorCards = (env: TestEnv) => env.messages.filter((m) => m.payload?.type === 'error')

describe('agent host: settings hooks', () => {
  it('retries a failed LLM call once with the fallback model', async () => {
    const reserve = new FakeProvider({ script: [{ text: 'Answer from the fallback model.' }] })
    const fallback: ResolvedModel = {
      kind: 'native',
      provider: reserve,
      providerId: 'prv_reserve',
      model: 'reserve',
    }
    const { env, host, bot, say } = await setup([{ error: 'HTTP 429 quota exceeded' }], {
      resolveFallbackModel: async () => fallback,
    })
    say('hi')
    await host.idle(bot.id)
    expect(botTexts(env)).toEqual(['Answer from the fallback model.'])
    expect(errorCards(env)).toHaveLength(0)
    expect(env.llmCalls.map((c) => [c.model, c.error !== null])).toEqual([
      ['fake-model', true],
      ['reserve', false],
    ])
  })

  it('shows the provider error when no fallback is configured or the fallback fails too', async () => {
    const reserve = new FakeProvider({ script: [{ error: 'down too' }] })
    const { env, host, bot, say } = await setup([{ error: 'HTTP 500' }], {
      resolveFallbackModel: async () => ({ kind: 'native', provider: reserve, providerId: 'r', model: 'r' }),
    })
    say('hi')
    await host.idle(bot.id)
    expect(errorCards(env)).toHaveLength(1)
    expect(env.llmCalls).toHaveLength(2)
  })

  it('runs a Claude Code bot on the fallback while its subscription quota is exhausted', async () => {
    const reserve = new FakeProvider({ script: [{ text: 'Done through the API.' }] })
    const { env, host, bot, say } = await setup([], {
      resolveModel: async (): Promise<ResolvedModel> => ({
        kind: 'cli',
        engine: 'claude_code',
        providerId: 'prv_cc',
        model: 'sonnet',
        env: {},
        idleTimeoutMs: 1000,
      }),
      providerExhausted: (id: string) => id === 'prv_cc',
      resolveFallbackModel: async () => ({ kind: 'native', provider: reserve, providerId: 'r', model: 'r' }),
    })
    say('hi')
    await host.idle(bot.id)
    expect(botTexts(env)).toEqual(['Done through the API.'])
  })

  it('holds every queue while the spend limit is reached and resumes on release', async () => {
    const { env, host, bot, say } = await setup([{ text: 'Back.' }])
    host.hold(true)
    say('hi')
    await new Promise((r) => setTimeout(r, 30))
    expect(env.llmCalls).toHaveLength(0)
    host.hold(false)
    await host.idle(bot.id)
    expect(botTexts(env)).toEqual(['Back.'])
  })

  it("names the app's language in the system prompt", async () => {
    const { provider, host, bot, say } = await setup([{ text: 'ok' }], { userLanguage: () => 'en' })
    say('hi')
    await host.idle(bot.id)
    const system = provider.requests[0]?.messages[0]
    const text = system?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
    expect(text).toContain("The user's language is English")
  })

  it('puts the catalog of active skills in the prompt and offers and runs only the tools they enable', async () => {
    const families = new Set(TOOL_FAMILY_NAMES.filter((f) => f !== 'computer'))
    const { provider, env, host, bot, say } = await setup(
      [
        { toolCalls: [{ name: 'computer', arguments: { action: 'screenshot' } }] },
        { toolCalls: [{ name: 'skill_load', arguments: { name: 'web-browsing' } }] },
        { text: 'ok' },
      ],
      {
        skillContext: () => ({
          catalog: formatSkillCatalog([{ name: 'web-browsing', description: 'Websites.' }]),
          families,
        }),
      },
    )
    say('hi')
    await host.idle(bot.id)
    const request = provider.requests[0]
    const system = request?.messages[0]?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
    expect(system).toContain('# Skills')
    expect(system).toContain('- web-browsing — Websites.')
    const offered = request?.tools?.map((t) => t.name) ?? []
    expect(offered).not.toContain('computer')
    expect(offered).toEqual(expect.arrayContaining(['browser_snapshot', 'skill_load']))
    expect(env.toolLog.map((c) => c.name)).toEqual(['skill_load'])
    const refused = [...env.toolCalls.values()].find((c) => c.toolName === 'computer')
    expect(refused?.status).toBe('error')
    expect(JSON.stringify(refused?.result)).toContain('turned off for you')
  })
})

describe('agentSettings', () => {
  const read = (settings: Record<string, unknown>) =>
    agentSettings(<T>(key: string, fallback: T) => (key in settings ? (settings[key] as T) : fallback))

  it('uses the defaults for missing or invalid values', () => {
    const settings = read({ 'agents.max_parallel': 0 })
    expect(settings.maxParallel()).toBe(3)
    expect(settings.maxParallelSessions()).toBe(2)
  })

  it('reads the configured values', () => {
    const settings = read({ 'agents.max_parallel': 5, 'agents.max_parallel_sessions': 1 })
    expect(settings.maxParallel()).toBe(5)
    expect(settings.maxParallelSessions()).toBe(1)
  })

  it('positiveInt accepts only positive integers', () => {
    expect([4, 0, -1, 1.5, '3', null].map(positiveInt)).toEqual([4, null, null, null, null, null])
  })
})
