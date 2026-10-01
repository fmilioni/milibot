import { cliSettingKeys } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { cliKeys } from '../cli/keys'
import { cliPrompt } from '../cli/prompt'
import { cliComposition, type CliSessionMeta, measureBaseTokens, rotationReason } from '../cli/rotation'
import { DefaultAgentHost } from '../host/agent-host'
import { FakeProvider } from '../llm/fake'
import { compositionTotal } from '../memory/tokens'
import { formatSkillCatalog } from '../prompts/skill-catalog'
import type { SkillContext } from '../skills/context'
import { claudeProfile, FakeBackend, turnFixture } from '../test-support/claude-code'
import { makeBot, TestEnv } from '../test-support/env'
import { TOOL_FAMILY_NAMES } from '../tools/policy'

describe('Claude Code session rotation', () => {
  const settings = { rotateIdleMinutes: 55, rotateContextTokens: 60_000 }
  const meta = (over: Partial<CliSessionMeta> = {}): CliSessionMeta => ({
    sessionId: 's1',
    profile: 'p',
    model: 'sonnet',
    lastUsedAt: 1_000_000,
    contextTokens: 30_000,
    baseTokens: 7_000,
    ...over,
  })
  const check = (
    m: CliSessionMeta | null,
    now: number,
    extra: { sessionId?: string | null; model?: string } = {},
  ) =>
    rotationReason({
      sessionId: extra.sessionId === undefined ? 's1' : extra.sessionId,
      meta: m,
      profile: 'p',
      model: extra.model ?? 'sonnet',
      now,
      settings,
    })

  it('decides from idle time, context size, model and profile', () => {
    expect(check(meta(), 1_000_000 + 54 * 60_000)).toBeNull()
    expect(check(meta(), 1_000_000 + 56 * 60_000)).toBe('idle')
    expect(check(meta({ contextTokens: 60_001 }), 1_000_100)).toBe('context_size')
    expect(check(meta(), 1_000_100, { model: 'opus' })).toBe('model_changed')
    expect(check(meta({ profile: 'old' }), 1_000_100)).toBe('config_changed')
    expect(check(null, 1_000_100)).toBe('config_changed')
    expect(check(meta({ sessionId: 'other' }), 1_000_100)).toBe('config_changed')
    expect(check(null, 1_000_100, { sessionId: null })).toBeNull()
  })

  function rotationEnv() {
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
    const conversation = env.addBot(bot)
    return { backend, env, bot, conversation }
  }

  async function turn(env: TestEnv, conversationId: string, botId: string, text: string) {
    const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversationId, text))
    await host.idle(botId)
    await host.stop()
  }

  it('starts a fresh session with the memory bootstrap after the cache TTL', async () => {
    const { backend, env, bot, conversation } = rotationEnv()
    env.memory.saveNote({ botId: bot.id, content: 'Prefers short answers.', pinned: true })
    await turn(env, conversation.id, bot.id, 'hi')
    await turn(env, conversation.id, bot.id, 'how are you?')
    expect(backend.specs[1]?.argv).toContain('--resume')

    env.advance(56 * 60_000)
    await turn(env, conversation.id, bot.id, 'voltei')
    const argv = backend.specs[2]?.argv ?? []
    expect(argv).not.toContain('--resume')
    expect(backend.appendedPrompts[2]).toContain('Prefers short answers.')
    const line = env.messages.find((m) => m.kind === 'system_event')
    expect(line?.payload).toMatchObject({
      type: 'system',
      event: 'session_rotated',
      params: { reason: 'idle', idleMinutes: 56 },
    })
    expect(env.llmCalls.at(-1)?.request).toMatchObject({ rotated: 'idle', freshSession: true })
  })

  it("gives the conversation's project block in the input when it changes, never in the bootstrap", async () => {
    const { backend, env, bot, conversation } = rotationEnv()
    let block = '# Current project: Store\nE-commerce.'
    env.projects = {
      resolve: (ref) => (ref === 'prj_1' ? { project: { id: 'prj_1', name: 'Store' } } : { general: true }),
      block: () => block,
    }
    const lastInput = () => {
      const line = backend.stdin.filter(Boolean).at(-1)
      return line ? JSON.stringify(JSON.parse(line)).replace(/\\n/g, '\n') : ''
    }
    conversation.projectId = 'prj_1'
    await turn(env, conversation.id, bot.id, 'hi')
    expect(backend.appendedPrompts[0]).toContain('# Your role')
    expect(backend.appendedPrompts[0]).not.toContain('E-commerce')
    expect(lastInput()).toContain('[Milibot] # Current project: Store\nE-commerce.')

    await turn(env, conversation.id, bot.id, 'and now?')
    expect(lastInput()).not.toContain('E-commerce.')
    expect(lastInput()).toContain('[Milibot] Current project of this conversation: Store.')

    block = '# Current project: Store\nE-commerce with an app.'
    await turn(env, conversation.id, bot.id, 'mudou?')
    expect(lastInput()).toContain('E-commerce with an app.')

    conversation.projectId = null
    await turn(env, conversation.id, bot.id, 'no project')
    expect(lastInput()).toContain('This conversation has no current project')
    expect(backend.specs.slice(1).every((spec) => spec.argv.includes('--resume'))).toBe(true)
  })

  it('rotates when the last request of the session passed the context threshold', async () => {
    const { backend, env, bot, conversation } = rotationEnv()
    env.setSetting(cliSettingKeys('claude_code').rotateContextTokens, 15_000)
    // The last request of the turn reads 12k and writes 5k from the cache.
    const big = turnFixture.map((line) => {
      const event = JSON.parse(line) as {
        type: string
        message?: { content?: Array<{ text?: string }>; usage?: unknown }
      }
      if (event.type !== 'assistant' || event.message?.content?.[0]?.text !== 'The folder is empty.')
        return line
      event.message.usage = {
        input_tokens: 9,
        cache_read_input_tokens: 12_000,
        cache_creation_input_tokens: 5000,
        output_tokens: 5,
      }
      return JSON.stringify(event)
    })
    backend.script = big
    await turn(env, conversation.id, bot.id, 'hi')
    expect(
      env.getSetting<CliSessionMeta | null>(cliKeys('claude_code').meta(bot.id), null)?.contextTokens,
    ).toBe(17_009)
    await turn(env, conversation.id, bot.id, 'and now?')
    expect(backend.specs[1]?.argv).not.toContain('--resume')
    expect(env.messages.find((m) => m.kind === 'system_event')?.payload).toMatchObject({
      params: { reason: 'context_size', contextTokens: 17_009 },
    })
  })

  it('silently rotates when the prompt changes, but not when only the memory does', async () => {
    const { backend, env, bot, conversation } = rotationEnv()
    await turn(env, conversation.id, bot.id, 'hi')
    env.memory.saveNote({ botId: bot.id, content: 'New note.', pinned: true })
    await turn(env, conversation.id, bot.id, 'and now?')
    expect(backend.specs[1]?.argv).toContain('--resume')

    env.bots.set(bot.id, { ...bot, systemPrompt: 'You now handle the finances.' })
    await turn(env, conversation.id, bot.id, 'mudou algo?')
    const argv = backend.specs[2]?.argv ?? []
    expect(argv).not.toContain('--resume')
    expect(backend.appendedPrompts[2]).toContain('You now handle the finances.')
    expect(env.messages.some((m) => m.kind === 'system_event')).toBe(false)
    expect(env.llmCalls.at(-1)?.request).toMatchObject({ rotated: 'config_changed', freshSession: true })
  })

  it('rotates sessions started before a prompt rule changed so the new rule takes effect', async () => {
    const { backend, env, bot, conversation } = rotationEnv()
    const rule = 'Report outcomes, not process'
    const current = cliPrompt('claude_code', bot, env.listBots())
    expect(current.instructions).toContain(rule)
    const oldPrompt = {
      ...current,
      instructions: current.instructions.replace(/\n- Report outcomes, not process[^\n]*/, ''),
    }
    backend.setSessionId(bot.id, 'old-session')
    env.setSetting(cliKeys('claude_code').meta(bot.id), {
      sessionId: 'old-session',
      profile: claudeProfile(oldPrompt),
      model: 'sonnet',
      lastUsedAt: env.now(),
      contextTokens: 20_000,
      baseTokens: null,
    })
    await turn(env, conversation.id, bot.id, 'hi')
    const argv = backend.specs[0]?.argv ?? []
    expect(argv).not.toContain('--resume')
    expect(backend.appendedPrompts[0]).toContain(rule)
    expect(argv[argv.indexOf('--system-prompt') + 1]).toContain('No one confirms each tool call')
    expect(env.messages.some((m) => m.kind === 'system_event')).toBe(false)
  })

  it('profiles the prompt text and tool docs, not the memory', () => {
    const bot = makeBot()
    const base = claudeProfile(cliPrompt('claude_code', bot, []))
    expect(claudeProfile(cliPrompt('claude_code', bot, []))).toBe(base)
    expect(claudeProfile(cliPrompt('claude_code', bot, []), false)).not.toBe(base)
    expect(claudeProfile(cliPrompt('claude_code', { ...bot, systemPrompt: 'outro papel' }, []))).not.toBe(
      base,
    )
  })

  it('changes the profile when a skill is turned on or off (catalog and MCP tools)', () => {
    const bot = makeBot()
    const all = new Set(TOOL_FAMILY_NAMES)
    const catalog = formatSkillCatalog([{ name: 'web-browsing', description: 'Websites.' }])
    const profile = (skills: SkillContext) =>
      claudeProfile(cliPrompt('claude_code', bot, [], null, 'main', skills))
    const base = profile({ catalog, families: all })
    expect(profile({ catalog, families: all })).toBe(base)
    expect(profile({ catalog: '', families: all })).not.toBe(base)
    const withoutBrowser = new Set([...all].filter((f) => f !== 'browser'))
    expect(profile({ catalog, families: withoutBrowser })).not.toBe(base)
    const prompt = cliPrompt('claude_code', bot, [], null, 'main', { catalog, families: withoutBrowser })
    expect(prompt.instructions).toContain('- web-browsing — Websites.')
    expect(prompt.mcpTools.map((t) => t.name)).not.toContain('browser_snapshot')
  })

  it('rotates when the bot switches model', async () => {
    const { backend, env, bot, conversation } = rotationEnv()
    await turn(env, conversation.id, bot.id, 'hi')
    env.resolveModel = async () => ({
      kind: 'cli',
      engine: 'claude_code',
      providerId: 'prv_cc',
      model: 'opus',
      env: {},
      idleTimeoutMs: 60_000,
    })
    await turn(env, conversation.id, bot.id, 'and now?')
    expect(backend.specs[1]?.argv).not.toContain('--resume')
    expect(backend.specs[1]?.argv).toContain('opus')
    expect(env.messages.find((m) => m.kind === 'system_event')?.payload).toMatchObject({
      params: { reason: 'model_changed' },
    })
  })
})

describe('Claude Code context composition', () => {
  const parts = {
    base: 7000,
    persona: 1500,
    mcpTools: 2500,
    longTermMemory: 300,
    summaries: 0,
    recap: 200,
    input: 50,
  }

  it('counts the fixed parts once per request and leaves the rest to the session history', () => {
    const c = cliComposition(parts, 3, 60_000)
    expect(c).toMatchObject({
      base: 21_000,
      systemPrompt: 4500,
      tools: 7500,
      longTermMemory: 900,
      recentTail: 750,
      retrieved: 0,
    })
    expect(c.history).toBe(60_000 - (21_000 + 4500 + 7500 + 900 + 750))
  })

  it('scales down the estimates when they exceed the billed prompt tokens', () => {
    const c = cliComposition(parts, 1, 10_000)
    expect(c.history).toBe(0)
    const total = (Object.values(c) as number[]).reduce((sum, v) => sum + (v ?? 0), 0)
    expect(total).toBe(10_000)
  })

  it('measures the Claude Code base from the first request of a fresh session', () => {
    expect(measureBaseTokens(12_000, { ...parts })).toBe(12_000 - 1500 - 2500 - 300 - 200 - 50)
    expect(measureBaseTokens(null, parts)).toBeNull()
    expect(measureBaseTokens(1000, parts)).toBeNull()
  })

  it('records base, Milibot parts and history in the llm call', async () => {
    const env = new TestEnv(new FakeProvider({ script: [] }))
    env.cli = { claude_code: new FakeBackend() }
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
    await host.idle(bot.id)
    const composition = env.llmCalls.at(-1)?.contextComposition
    expect(composition?.base).toBeGreaterThan(0)
    expect(composition?.systemPrompt).toBeGreaterThan(0)
    expect(composition?.tools).toBeGreaterThan(0)
    const total = composition ? compositionTotal(composition) : 0
    expect(total).toBe(9 + 12_000 + 5000)
    await host.stop()
  })
})
