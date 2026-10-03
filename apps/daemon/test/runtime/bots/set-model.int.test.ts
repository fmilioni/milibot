import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type { Bot, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { Db } from '../../../src/db/sqlite'
import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let db: Db
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let provider: FakeProvider
let events: WorkspaceEvent[]
let chiefId: string
let chiefDm: string
let anaId: string
let anaDm: string
/** The `set_model` arguments the next user message makes the bot send. */
let pending: Record<string, unknown> | null = null

const dir = useTempDir('set-model')
afterEach(stopRuntimes)

function script(request: CompletionRequest): FakeStep {
  if (request.messages.at(-1)?.role === 'tool') return { text: 'ok' }
  const args = pending
  pending = null
  return args ? { toolCalls: [{ name: 'set_model', arguments: args }] } : { text: 'hello' }
}

async function boot(options: { fresh?: boolean } = {}) {
  h = await bootRuntime({
    dir: dir(),
    vm: false,
    script,
    host: { compaction: false },
    ...(options.fresh === false ? { db } : {}),
  })
  ;({ db, runtime, host, provider, events, botId: chiefId, dm: chiefDm } = h)
  await host.idle()
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

/** A provider with one model taking low/high, Ana on it at its default effort. */
async function setUp() {
  await boot()
  const lab = await call<{ id: string }>(
    'createProvider',
    {},
    { type: 'openai_compatible', name: 'Lab', baseUrl: 'http://127.0.0.1:9/v1' },
  )
  for (const [modelId, displayName] of [
    ['lab/big-model', 'Big Model'],
    ['lab/other-model', 'Other Model'],
  ])
    await call(
      'createProviderModel',
      { providerId: lab.id },
      { modelId, displayName, contextWindow: 200_000, efforts: ['low', 'high'] },
    )
  const ana = runtime.store.bots.create({
    name: 'Ana',
    label: 'Finance',
    systemPrompt: 'You are Ana.',
    providerId: lab.id,
    model: 'lab/big-model',
  })
  anaId = ana.id
  anaDm = runtime.store.conversations.create({ type: 'direct', botIds: [ana.id] }).id
  await call('updateBot', { botId: chiefId }, { providerId: lab.id, model: 'lab/big-model' })
  return lab.id
}

async function say(args: Record<string, unknown>, conversationId = anaDm) {
  pending = args
  await call('postMessage', { conversationId }, { content: 'change your model settings' })
  await host.idle()
}

const bot = (id: string) => runtime.store.bots.list().find((b) => b.id === id) as Bot

const lastToolResult = () =>
  (provider.requests.at(-1)?.messages ?? [])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')))
    .join('\n')

describe('set_model', () => {
  it('changes the effort from the next turn on, tells the app and survives a restart', async () => {
    await setUp()
    await say({ effort: 'high' })

    expect(lastToolResult()).toContain(
      'You now work on Big Model (Lab), effort high, from your next turn on.',
    )
    expect(bot(anaId)).toMatchObject({ model: 'lab/big-model', effort: 'high' })
    const updated = events.filter((e) => e.type === 'bot.updated' && e.payload.bot.id === anaId).at(-1)
    expect(updated).toMatchObject({ payload: { bot: { effort: 'high' } } })

    const before = provider.requests.length
    await call('postMessage', { conversationId: anaDm }, { content: 'hi' })
    await host.idle()
    expect(provider.requests.slice(before).at(0)).toMatchObject({ model: 'lab/big-model', effort: 'high' })

    await h.stop()
    await boot({ fresh: false })
    expect(bot(anaId)).toMatchObject({ model: 'lab/big-model', effort: 'high' })
  })

  it('switches the model, keeping the effort the new one takes', async () => {
    await setUp()
    await say({ effort: 'low' })
    await say({ model: 'other model' })
    expect(bot(anaId)).toMatchObject({ model: 'lab/other-model', effort: 'low' })
    await say({ effort: 'default' })
    expect(bot(anaId).effort).toBeNull()
  })

  it('refuses an effort the model does not take and an unknown model, changing nothing', async () => {
    await setUp()
    await say({ effort: 'max' })
    expect(lastToolResult()).toContain(
      'Not changed: "max" is not an effort level of Big Model: use one of low, high, or default.',
    )
    await say({ effort: 'turbo' })
    expect(lastToolResult()).toContain('"turbo" is not an effort level of Big Model')
    await say({ model: 'nonexistent' })
    expect(lastToolResult()).toContain('Not changed: No model matches "nonexistent"')
    await say({})
    expect(lastToolResult()).toContain('Say what to change')
    expect(bot(anaId)).toMatchObject({ model: 'lab/big-model', effort: null })
  })

  it("changes another bot's model only for a bot that manages the team", async () => {
    await setUp()
    await say({ bot: bot(chiefId).name, effort: 'high' })
    expect(lastToolResult()).toContain("Only a bot that manages the team can change another bot's model")
    expect(bot(chiefId).effort).toBeNull()

    await say({ bot: 'Ana', effort: 'high' }, chiefDm)
    expect(lastToolResult()).toContain(
      'Ana now works on Big Model (Lab), effort high, from its next turn on.',
    )
    expect(bot(anaId).effort).toBe('high')
  })
})
