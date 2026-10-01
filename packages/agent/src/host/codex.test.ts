import { describe, expect, it } from 'vitest'

import { cliKeys } from '../cli/keys'
import type { CliSessionMeta } from '../cli/rotation'
import type * as CodexProtocol from '../codex/protocol'
import type { CliResolvedModel, ResolvedModel } from '../environment'
import { FakeProvider } from '../llm/fake'
import { FakeCodexBackend, readCodexFixture } from '../test-support/codex'
import { makeBot, TestEnv } from '../test-support/env'
import { DefaultAgentHost } from './agent-host'

const codexModel = (extra: Partial<CliResolvedModel> = {}): ResolvedModel => ({
  kind: 'cli',
  engine: 'codex',
  providerId: 'prv_codex',
  model: 'gpt-6.1-sol',
  env: {},
  config: {},
  idleTimeoutMs: 60_000,
  ...extra,
})

function setup(backend = new FakeCodexBackend()) {
  const env = new TestEnv(new FakeProvider({ script: [] }))
  env.cli = { codex: backend }
  env.resolveModel = async () => codexModel()
  const bot = makeBot({ slug: 'iris' })
  const conversation = env.addBot(bot)
  const host = new DefaultAgentHost({ deltaFlushMs: 1 })
  return { env, bot, conversation, host, backend }
}

describe('DefaultAgentHost with Codex', () => {
  it('shows Codex commands and patches as activity steps, with the patches on the tool call', async () => {
    const { env, bot, conversation, host, backend } = setup()
    const limits: CodexProtocol.RateLimitSnapshot[] = []
    env.cliQuota = (_providerId, _engine, snapshot) =>
      limits.push(snapshot as CodexProtocol.RateLimitSnapshot)
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'check the notes'))
    await host.idle(bot.id)

    const activity = env.messages.find((m) => m.kind === 'activity')
    if (activity?.payload?.type !== 'activity') throw new Error('expected an activity card')
    expect(activity.payload.steps.map((s) => [s.kind, s.detail, s.status])).toEqual([
      ['note', 'Let me check.', 'ok'],
      ['file_read', '/workspace/demo/notes.txt', 'ok'],
      ['file_edit', '/workspace/demo/new.txt, /workspace/demo/notes.txt', 'ok'],
    ])
    const patch = activity.payload.steps[2]
    expect(patch?.files).toEqual([
      { path: '/workspace/demo/new.txt', status: 'added', additions: 1, deletions: 0 },
      { path: '/workspace/demo/notes.txt', status: 'modified', additions: 1, deletions: 1 },
    ])
    const patchCall = [...env.toolCalls.values()].find((t) => t.toolName === 'codex.apply_patch')
    expect(patchCall?.diffs?.map((d) => d.patch)).toEqual([
      '@@ -0,0 +1,1 @@\n+hello',
      '@@ -1,2 +1,2 @@\n line one\n-line two\n+line 2',
    ])
    const reply = env.messages.filter((m) => m.kind === 'text' && m.authorBotId === bot.id).at(-1)
    expect(reply?.content).toBe('All done.')

    const call = env.llmCalls.at(-1)
    expect(call).toMatchObject({ providerType: 'codex', model: 'gpt-6.1-sol', error: null })
    expect(call?.usage.cachedReadTokens).toBe(40)
    // 4860 input × $2 + 40 cached × $0.10 + 150 output (reasoning included) × $10, per 1M tokens.
    expect(call?.usage.costSource).toBe('computed')
    expect(call?.usage.costUsd).toBeCloseTo(0.011224, 6)
    expect(limits[0]?.primary?.usedPercent).toBe(43)
    const meta = env.getSetting<CliSessionMeta | null>(cliKeys('codex').meta(bot.id), null)
    expect(meta).toMatchObject({ sessionId: 'thread-1', model: 'gpt-6.1-sol', contextTokens: 1400 })

    const start = backend.requests.find((r) => r.method === 'thread/start')
    const instructions = String(start?.params.developerInstructions)
    expect(instructions).toContain('shell and apply_patch')
    expect(instructions).toContain('never request_user_input or spawn_agent')
    await host.stop()
  })

  it('resumes the thread on the next turn and rotates it when the model changes', async () => {
    const { env, bot, conversation, host, backend } = setup()
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'one'))
    await host.idle(bot.id)
    host.onMessageCreated(env.userMessage(conversation.id, 'two'))
    await host.idle(bot.id)
    expect(backend.methods().filter((m) => m.startsWith('thread/'))).toEqual(['thread/start'])

    env.resolveModel = async () => codexModel({ model: 'gpt-6-astra' })
    host.onMessageCreated(env.userMessage(conversation.id, 'three'))
    await host.idle(bot.id)
    expect(backend.methods().filter((m) => m.startsWith('thread/'))).toEqual(['thread/start', 'thread/start'])
    expect(backend.specs).toHaveLength(2)
    expect(
      env.messages.some((m) => m.kind === 'system_event' && m.content.includes('switched to the new model')),
    ).toBe(true)
    await host.stop()
  })

  it('offers the login when Codex is not signed in', async () => {
    const backend = new FakeCodexBackend()
    backend.turnScripts = [readCodexFixture('turn-unauthorized.ndjson')]
    const { env, bot, conversation, host } = setup(backend)
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    const card = env.messages.find((m) => m.payload?.type === 'error')
    expect(card?.payload).toMatchObject({
      type: 'error',
      code: 'cli_login_required',
      params: { engine: 'codex' },
    })
    await host.stop()
  })

  it("runs a chat helper's thread in the read-only sandbox", async () => {
    const { env, bot, conversation, host, backend } = setup()
    const parent = new FakeProvider({
      script: (request) =>
        request.messages.at(-1)?.role === 'user'
          ? { toolCalls: [{ name: 'subagent', arguments: { task: 'map the routes' } }] }
          : { text: 'plan ready' },
    })
    env.resolveModel = async (_bot, options) =>
      options?.laneKey?.includes(':sub:')
        ? codexModel()
        : { kind: 'native', provider: parent, providerId: 'prv_api', model: 'fake' }
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'plan the change'))
    await host.idle(bot.id)
    const start = backend.requests.find((r) => r.method === 'thread/start')
    expect(start?.params.sandbox).toBe('read-only')
    await host.stop()
  })

  it('runs on the fallback model while the subscription quota is exhausted', async () => {
    const { env, bot, conversation, host, backend } = setup()
    env.providerExhausted = (providerId) => providerId === 'prv_codex'
    env.resolveFallbackModel = async () => ({
      kind: 'native',
      provider: new FakeProvider({ script: [{ text: 'from the fallback' }] }),
      providerId: 'prv_api',
      model: 'fake',
    })
    await host.start(env)
    host.onMessageCreated(env.userMessage(conversation.id, 'hi'))
    await host.idle(bot.id)
    expect(backend.specs).toHaveLength(0)
    expect(env.messages.some((m) => m.content === 'from the fallback')).toBe(true)
    await host.stop()
  })
})
