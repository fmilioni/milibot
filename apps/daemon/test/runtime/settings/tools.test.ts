import type { ModelRequest, ToolExecContext } from '@milibot/agent'
import type { ToolCall } from '@milibot/agent/llm'
import { makeBot } from '@milibot/agent/testing'
import { DEFAULT_WORKSPACE_PREFERENCES, type WorkspacePreferences } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { BOT_SETTING_NAMES, USER_ONLY_SETTINGS } from '../../../src/runtime/settings/bot-fields'
import { WorkspaceSettingsTools } from '../../../src/runtime/settings/tools'

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? '').join('')

const ana = makeBot({ name: 'Ana' })
const dex = makeBot({ name: 'Dex' })

function harness() {
  let prefs: WorkspacePreferences = { ...DEFAULT_WORKSPACE_PREFERENCES }
  const proposed: unknown[] = []
  const tools = new WorkspaceSettingsTools({
    settings: {
      preferences: () => prefs,
      update: (patch) => (prefs = { ...prefs, ...patch }),
    },
    changes: {
      propose: (_ctx, changes) => {
        proposed.push(changes)
        return Promise.resolve('The user approved it.')
      },
    },
    listBots: () => [ana, dex],
    catalog: () => [
      {
        provider: { id: 'prov_a', type: 'anthropic', name: 'Anthropic', preset: null },
        models: [
          { modelId: 'claude-opus-5-5', displayName: 'Opus 5.5', contextWindow: 200_000, efforts: ['high'] },
        ],
      },
    ],
    resolveModel: (_bot, request: ModelRequest) =>
      /opus/i.test(request.model ?? '')
        ? {
            ok: true,
            choice: {
              providerId: 'prov_a',
              model: 'claude-opus-5-5',
              effort: request.effort ?? null,
              contextLimit: null,
              maxOutputTokens: null,
            },
            label: 'Opus 5.5',
            notes: [],
          }
        : { ok: false, error: `No model matches "${request.model}".` },
    imageModels: () => [
      { providerId: 'prov_i', modelId: 'google/imagen-4', displayName: 'Imagen 4', providerName: 'Google' },
    ],
  })
  const ctx: ToolExecContext = {
    bot: ana,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  const run = async (settings: unknown) =>
    text(
      await tools.execute(ctx, {
        id: 't1',
        name: 'workspace_settings_update',
        arguments: { settings },
      } as ToolCall),
    )
  return { run, prefs: () => prefs, proposed, tools, ctx }
}

describe('workspace settings tools', () => {
  it('cover every preference: allowed to bots or only the user', () => {
    expect([...BOT_SETTING_NAMES, ...USER_ONLY_SETTINGS].sort()).toEqual(
      Object.keys(DEFAULT_WORKSPACE_PREFERENCES).sort(),
    )
  })

  it('turns model names into choices and back into names', async () => {
    const h = harness()
    expect(await h.run({ fallbackModel: { model: 'opus', effort: 'high' }, triageModel: 'auto' })).toContain(
      'Changed: fallbackModel null → claude-opus-5-5 (Anthropic, effort high)',
    )
    expect(h.prefs().fallbackModel).toMatchObject({ providerId: 'prov_a', model: 'claude-opus-5-5' })
    expect(await h.run({ summaryModel: 'gpt-9' })).toBe(
      'Invalid input: summaryModel: No model matches "gpt-9".',
    )
    expect(await h.run({ newBotModel: 42 })).toMatch(/newBotModel: give a model name or id/)
    expect(await h.run({ fallbackModel: null })).toContain('fallbackModel claude-opus-5-5')
    expect(h.prefs().fallbackModel).toBeNull()
  })

  it('picks enabled image models and bots by name', async () => {
    const h = harness()
    expect(await h.run({ imageModel: 'imagen-4', mutedBots: ['dex', 'Ana'] })).toContain(
      'mutedBots [] → ["Dex","Ana"]; imageModel null (first enabled) → google/imagen-4 (Google)',
    )
    expect(h.prefs()).toMatchObject({
      imageModel: { providerId: 'prov_i', model: 'google/imagen-4' },
      mutedBots: [dex.id, ana.id],
    })
    expect(await h.run({ imageModel: 'dall-e' })).toContain('no enabled image model "dall-e"')
  })

  it('picks the idle watch bot by name and clears it with null', async () => {
    const h = harness()
    expect(await h.run({ idleWatchBotId: 'ana', idleWatchMinutes: 15 })).toContain(
      'idleWatchMinutes 30 → 15; idleWatchBotId null → "Ana"',
    )
    expect(h.prefs()).toMatchObject({ idleWatchBotId: ana.id, idleWatchMinutes: 15 })
    expect(await h.run({ idleWatchBotId: 'nobody' })).toContain(
      'idleWatchBotId: no single bot matches "nobody"',
    )
    expect(await h.run({ idleWatchBotId: 'none' })).toContain('idleWatchBotId "Ana" → null')
  })

  it('sends only the fields that need confirmation to the card', async () => {
    const h = harness()
    const result = await h.run({ spendPauseUsd: 'none', spendWarnUsd: 2.5, draftPrs: false })
    expect(result).toContain('Changed: draftPrs true → false.')
    expect(result).toContain(
      'Asked the user to confirm spendWarnUsd null (no limit) → 2.5: The user approved it.',
    )
    expect(h.proposed).toEqual([[{ field: 'spendWarnUsd', from: null, to: 2.5 }]])
    expect(h.prefs().spendWarnUsd).toBeNull()
    expect(await h.run({ spendWarnUsd: -1 })).toMatch(/spendWarnUsd: .*>0/)
  })
})
