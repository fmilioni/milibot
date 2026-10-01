import { PREFERENCE_SETTING_KEYS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { createModelPolicy } from '../../../src/runtime/providers/model-policy'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { testProviders } from '../../support/providers'

async function setup() {
  const db = openWorkspaceDb(':memory:')
  const store = new WorkspaceStore(db, () => 1)
  const { store: providers, catalog } = testProviders(db)
  const mist = await providers.create({ type: 'openai_compatible', name: 'Mist', baseUrl: 'http://x/v1' })
  providers.createModel(mist.id, { modelId: 'big' })
  providers.createModel(mist.id, { modelId: 'flash' })
  providers.createModel(mist.id, { modelId: 'other' })
  const bot = store.bots.create({ name: 'Ana', providerId: mist.id, model: 'big', effort: 'high' })
  return { store, providers, mist, bot, policy: createModelPolicy(store, catalog) }
}

describe('model policy', () => {
  it("runs side work on the bot's own model, untuned, until its provider marks a light model", async () => {
    const { providers, mist, bot, policy } = await setup()
    expect(await policy.automatic(bot)).toMatchObject({
      source: 'bot',
      model: { model: 'big', effort: null },
    })
    await providers.update(mist.id, { lightModel: 'flash' })
    expect(await policy.automatic(bot)).toMatchObject({ source: 'light', model: { model: 'flash' } })
    expect(await policy.summaryModel(bot)).toMatchObject({ model: 'flash' })
    expect(await policy.triageModel([bot])).toMatchObject({ model: 'flash' })
    expect(await policy.knowledgeSummaryModel(bot)).toMatchObject({ model: 'flash' })
  })

  it('prefers the workspace choice and falls back when its provider is gone', async () => {
    const { store, mist, bot, policy } = await setup()
    store.settings.set(PREFERENCE_SETTING_KEYS.triageModel, {
      providerId: mist.id,
      model: 'other',
      effort: 'low',
    })
    expect(await policy.triageModel([bot])).toMatchObject({ model: 'other', effort: 'low' })
    store.settings.set(PREFERENCE_SETTING_KEYS.triageModel, { providerId: 'provider_gone', model: 'x' })
    expect(await policy.triageModel([bot])).toMatchObject({ model: 'big' })
  })

  it('summarizes documents with the conversation summary choice before the bot model', async () => {
    const { store, providers, mist, bot, policy } = await setup()
    store.settings.set(PREFERENCE_SETTING_KEYS.summaryModel, { providerId: mist.id, model: 'other' })
    expect(await policy.automaticKnowledgeSummary(bot)).toMatchObject({
      source: 'summary',
      model: { model: 'other' },
    })
    await providers.update(mist.id, { lightModel: 'flash' })
    expect(await policy.automaticKnowledgeSummary(bot)).toMatchObject({
      source: 'light',
      model: { model: 'flash' },
    })
  })
})
