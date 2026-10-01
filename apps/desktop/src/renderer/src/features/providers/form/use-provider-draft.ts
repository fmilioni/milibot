import type { DraftModel, Provider, ProviderModel } from '@milibot/shared'
import { useReducer } from 'react'

import {
  initialProviderDraft,
  isDraftUrlValid,
  type ProviderDraftFields,
  providerDraftReducer,
  providerSaveFields,
  toProviderDraft,
} from '@/features/providers/lib/provider-draft'
import { isOpenRouter, mergeFetched, type ModelRow } from '@/features/providers/lib/provider-form'

export function useProviderDraft(provider: Provider | undefined, savedModels: ProviderModel[]) {
  const [state, dispatch] = useReducer(providerDraftReducer, undefined, () =>
    initialProviderDraft(provider, savedModels),
  )
  const openRouter = isOpenRouter({ preset: provider?.preset ?? null, baseUrl: state.baseUrl })
  return {
    state,
    openRouter,
    urlValid: isDraftUrlValid(state.type, state.baseUrl),
    set: (patch: Partial<ProviderDraftFields>) => dispatch({ type: 'set', patch }),
    setRows: (update: (rows: ModelRow[]) => ModelRow[]) => dispatch({ type: 'rows', update }),
    applyFetched: (models: DraftModel[]) =>
      dispatch({ type: 'fetched', rows: mergeFetched(state.rows, models), openRouter }),
    draft: () => toProviderDraft(state, provider),
    saveFields: () => providerSaveFields(state, provider, openRouter),
  }
}
