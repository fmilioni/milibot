import type {
  OutputCapField,
  Provider,
  ProviderDraft,
  ProviderModel,
  ReasoningParam,
  ReasoningReplay,
} from '@milibot/shared'

import type { ProviderFormSave } from '../save-provider'
import {
  activeLightModel,
  formatHeaders,
  type ModelRow,
  parseHeaders,
  presetForUrl,
  rowFromModel,
  suggestedLightModel,
} from './provider-form'

export type DraftType = 'openai_compatible' | 'anthropic'

/** What the provider form edits, besides the search and image model tables. */
export interface ProviderDraftState {
  type: DraftType
  name: string
  baseUrl: string
  apiKey: string
  headers: string
  reasoningParam: ReasoningParam
  outputCapField: OutputCapField
  reasoningReplay: ReasoningReplay
  rows: ModelRow[]
  lightModel: string | null
}

export type ProviderDraftFields = Omit<ProviderDraftState, 'rows'>

export type ProviderDraftAction =
  | { type: 'set'; patch: Partial<ProviderDraftFields> }
  | { type: 'rows'; update: (rows: ModelRow[]) => ModelRow[] }
  /** Rows merged with the server's list; the light model follows when the marked one is gone. */
  | { type: 'fetched'; rows: ModelRow[]; openRouter: boolean }

export function initialProviderDraft(
  provider: Provider | undefined,
  savedModels: ProviderModel[],
): ProviderDraftState {
  return {
    type: provider?.type === 'anthropic' ? 'anthropic' : 'openai_compatible',
    name: provider?.name ?? '',
    baseUrl: provider?.baseUrl ?? '',
    apiKey: '',
    headers: formatHeaders(provider?.extraHeaders ?? {}),
    reasoningParam: provider?.reasoningParam ?? 'auto',
    outputCapField: provider?.outputCapField ?? 'auto',
    reasoningReplay: provider?.reasoningReplay ?? 'auto',
    rows: savedModels.map(rowFromModel),
    lightModel: provider?.lightModel ?? null,
  }
}

export function providerDraftReducer(
  state: ProviderDraftState,
  action: ProviderDraftAction,
): ProviderDraftState {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch }
    case 'rows':
      return { ...state, rows: action.update(state.rows) }
    case 'fetched': {
      const lightModel = activeLightModel(action.rows, state.lightModel)
        ? state.lightModel
        : (suggestedLightModel(state.type, action.openRouter, action.rows) ?? state.lightModel)
      return { ...state, rows: action.rows, lightModel }
    }
  }
}

/** An Anthropic URL is optional; an OpenAI-compatible server needs one. */
export function isDraftUrlValid(type: DraftType, baseUrl: string): boolean {
  const url = baseUrl.trim()
  return type === 'anthropic' ? !url || /^https?:\/\//.test(url) : /^https?:\/\/\S+$/.test(url)
}

/** The unsaved connection the daemon tests and lists models from. */
export function toProviderDraft(state: ProviderDraftState, provider: Provider | undefined): ProviderDraft {
  return {
    type: state.type,
    baseUrl: state.baseUrl.trim() || null,
    preset: provider?.preset ?? presetForUrl(state.baseUrl),
    ...(state.apiKey.trim() ? { apiKey: state.apiKey.trim() } : {}),
    extraHeaders: parseHeaders(state.headers),
    ...(provider ? { providerId: provider.id } : {}),
  }
}

export function providerSaveFields(
  state: ProviderDraftState,
  provider: Provider | undefined,
  openRouter: boolean,
): ProviderFormSave['fields'] {
  const { type, reasoningParam, outputCapField, reasoningReplay } = state
  return {
    name: state.name.trim(),
    baseUrl: state.baseUrl.trim() || null,
    extraHeaders: parseHeaders(state.headers),
    ...(state.apiKey.trim() ? { apiKey: state.apiKey.trim() } : {}),
    ...(type === 'openai_compatible' ? { reasoningParam, outputCapField, reasoningReplay } : {}),
    lightModel:
      type === 'anthropic'
        ? (provider?.lightModel ?? suggestedLightModel(type, openRouter, state.rows))
        : activeLightModel(state.rows, state.lightModel),
  }
}
