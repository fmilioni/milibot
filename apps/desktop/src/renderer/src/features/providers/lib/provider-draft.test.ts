import type { Provider } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  initialProviderDraft,
  isDraftUrlValid,
  providerDraftReducer,
  providerSaveFields,
  toProviderDraft,
} from './provider-draft'
import { blankRow, type ModelRow } from './provider-form'

const provider = {
  id: 'prov_1',
  type: 'openai_compatible',
  name: 'Local',
  baseUrl: 'http://10.0.0.2:1234/v1',
  preset: null,
  extraHeaders: { 'X-Org': 'acme' },
  lightModel: 'small',
  reasoningParam: 'auto',
  outputCapField: 'auto',
  reasoningReplay: 'auto',
} as unknown as Provider

const row = (modelId: string, enabled = true): ModelRow => ({ ...blankRow(), modelId, enabled })

describe('provider draft', () => {
  it('starts from the provider being edited, or blank', () => {
    const edited = initialProviderDraft(provider, [])
    expect(edited).toMatchObject({ type: 'openai_compatible', name: 'Local', headers: 'X-Org: acme' })
    expect(edited.lightModel).toBe('small')
    expect(initialProviderDraft(undefined, [])).toMatchObject({ name: '', baseUrl: '', lightModel: null })
  })

  it('sets fields and updates rows', () => {
    let state = initialProviderDraft(undefined, [])
    state = providerDraftReducer(state, { type: 'set', patch: { name: 'X', apiKey: 'k' } })
    state = providerDraftReducer(state, { type: 'rows', update: (rows) => [...rows, row('a')] })
    expect(state.name).toBe('X')
    expect(state.rows.map((r) => r.modelId)).toEqual(['a'])
  })

  it('keeps an active light model after a fetch and suggests one when it is gone', () => {
    const state = { ...initialProviderDraft(undefined, []), lightModel: 'a' }
    const kept = providerDraftReducer(state, { type: 'fetched', rows: [row('a')], openRouter: false })
    expect(kept.lightModel).toBe('a')
    const suggested = providerDraftReducer(state, {
      type: 'fetched',
      rows: [row('anthropic/claude-haiku-4.5')],
      openRouter: true,
    })
    expect(suggested.lightModel).toBe('anthropic/claude-haiku-4.5')
  })

  it('validates the URL per type', () => {
    expect(isDraftUrlValid('anthropic', '')).toBe(true)
    expect(isDraftUrlValid('openai_compatible', '')).toBe(false)
    expect(isDraftUrlValid('openai_compatible', 'http://x/v1')).toBe(true)
  })

  it('builds the draft and the saved fields', () => {
    const state = { ...initialProviderDraft(provider, []), apiKey: ' sk ', rows: [row('small')] }
    expect(toProviderDraft(state, provider)).toEqual({
      type: 'openai_compatible',
      baseUrl: 'http://10.0.0.2:1234/v1',
      preset: null,
      apiKey: 'sk',
      extraHeaders: { 'X-Org': 'acme' },
      providerId: 'prov_1',
    })
    expect(providerSaveFields(state, provider, false)).toMatchObject({
      name: 'Local',
      apiKey: 'sk',
      reasoningParam: 'auto',
      lightModel: 'small',
    })
  })
})
