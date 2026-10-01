import { FakeProvider, type FakeStep } from '@milibot/agent/testing'
import type { Language, WorkspacePreferences } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('settings')
afterEach(stopRuntimes)

function boot(script: FakeStep[] = [], language?: Language) {
  return bootRuntime({
    dir: dir(),
    provider: new FakeProvider({ script, fallback: { text: 'ok' } }),
    host: { compaction: false },
    ...(language ? { language } : {}),
  })
}

describe('settings service', () => {
  it("tells bots the user's language and why a pkill -f killed its own shell", async () => {
    // Portuguese on purpose: the workspace starts in pt-BR and the bot answers in it.
    const h = await boot(
      [
        { toolCalls: [{ name: 'bash', arguments: { command: 'pkill -f "vite --config x"; echo ok' } }] },
        { text: 'Feito.' },
        { text: 'Done.' },
      ],
      'pt-BR',
    )
    h.guest.state.execResult = () => ({
      code: 144,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: {},
      timedOut: false,
      durationMs: 1,
    })
    const system = (i: number) => {
      const first = h.provider.requests[i]?.messages[0]
      return first?.role === 'system' ? JSON.stringify(first.content) : ''
    }
    await h.call('postMessage', { conversationId: h.dm }, { content: 'stop vite' })
    await h.host.idle()
    expect(system(0)).toContain("The user's language is Brazilian Portuguese")
    const results = h.provider.requests[1]?.messages.filter((m) => m.role === 'tool') ?? []
    expect(JSON.stringify(results)).toContain('bracket pattern')

    await h.call('updateWorkspacePreferences', {}, { userLanguage: 'en' })
    await h.call('postMessage', { conversationId: h.dm }, { content: 'hi' })
    await h.host.idle()
    expect(system(2)).toContain("The user's language is English")
  })

  it('gives new bots the "New bots" model and keeps preferences', async () => {
    const h = await boot()
    const provider = await h.call<{ id: string }>(
      'createProvider',
      {},
      { type: 'openai_compatible', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
    )
    await h.call(
      'updateWorkspacePreferences',
      {},
      { newBotModel: { providerId: provider.id, model: 'qwen3-coder' }, maxParallelBots: 2, draftPrs: false },
    )
    const prefs = await h.call<WorkspacePreferences>('getWorkspacePreferences')
    expect(prefs).toMatchObject({ maxParallelBots: 2, draftPrs: false })
    const created = await h.call<{ bot: { providerId: string; model: string } }>(
      'createBot',
      {},
      { name: 'Dex' },
    )
    expect(created.bot).toMatchObject({ providerId: provider.id, model: 'qwen3-coder' })
    expect(h.runtime.store.settings.get('agents.max_parallel', 0)).toBe(2)
  })
})
