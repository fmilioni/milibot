import type {
  EmbeddingModelCandidate,
  EmbeddingModelCandidates,
  ProviderDraft,
  ProviderModel,
} from '@milibot/shared'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { providerDraft } from '@/features/providers/api'
import {
  type EmbeddingRow,
  embeddingRowFromModel,
  mergeEmbeddingCandidates,
} from '@/features/providers/lib/provider-form'
import type { EmbeddingTest } from '@/features/providers/tables/EmbeddingModelsTable'
import { errorMessage } from '@/lib/errors'

/** The provider form's search models: rows, per-row probes, the server listing and OpenRouter's suggestion. */
export function useEmbeddingModels({
  workspaceId,
  draft,
  saved,
  autoSuggest,
}: {
  workspaceId: string
  draft: () => ProviderDraft
  saved: ProviderModel[]
  /** A new form pointing at OpenRouter: adds the suggested model once. */
  autoSuggest: boolean
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<EmbeddingRow[]>(() => saved.map(embeddingRowFromModel))
  const [tests, setTests] = useState<Record<string, EmbeddingTest>>({})
  const [listing, setListing] = useState<EmbeddingModelCandidates | null>(null)
  const [fetching, setFetching] = useState<'list' | 'suggest' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const autoSuggested = useRef(false)

  const list = () => providerDraft.fetchEmbeddingModels(workspaceId, draft())

  const fetchList = async () => {
    setFetching('list')
    setNote(null)
    try {
      setListing(await list())
    } catch (err) {
      setNote(t('settings.providers.embedding.fetchFailed', { error: errorMessage(err) }))
    } finally {
      setFetching(null)
    }
  }

  /** Qwen3 Embedding with the price and context OpenRouter lists right now. */
  const addSuggested = async (quiet: boolean) => {
    setFetching('suggest')
    if (!quiet) setNote(null)
    try {
      const suggested = (await list()).models.filter((m) => m.suggested)
      if (suggested.length > 0) setRows((current) => mergeEmbeddingCandidates(current, suggested))
      else if (!quiet) setNote(t('settings.providers.embedding.suggestNone'))
    } catch (err) {
      if (!quiet) setNote(t('settings.providers.embedding.fetchFailed', { error: errorMessage(err) }))
    } finally {
      setFetching(null)
    }
  }

  useEffect(() => {
    if (!autoSuggest || autoSuggested.current || rows.length > 0) return
    autoSuggested.current = true
    void addSuggested(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when a new form points at OpenRouter
  }, [autoSuggest])

  const test = async (row: EmbeddingRow) => {
    const key = row.key
    setTests((all) => ({ ...all, [key]: { status: 'testing' } }))
    try {
      const result = await providerDraft.probeEmbedding(workspaceId, draft(), row.modelId.trim())
      if (result.ok && result.dimensions) {
        const dimensions = result.dimensions
        setRows((all) => all.map((r) => (r.key === key ? { ...r, dimensions } : r)))
        setTests((all) => ({ ...all, [key]: { status: 'ok', dimensions } }))
      } else {
        setTests((all) => ({
          ...all,
          [key]: { status: 'failed', code: result.errorCode ?? 'provider_error', error: result.error },
        }))
      }
    } catch (err) {
      setTests((all) => ({
        ...all,
        [key]: { status: 'failed', code: 'unreachable', error: errorMessage(err) },
      }))
    }
  }

  return {
    rows,
    setRows,
    tests,
    test,
    listing,
    closeListing: () => setListing(null),
    addPicked: (picked: EmbeddingModelCandidate[]) => {
      setRows((current) => mergeEmbeddingCandidates(current, picked))
      setListing(null)
    },
    fetching,
    note,
    fetchList,
    addSuggested,
  }
}

export type EmbeddingModels = ReturnType<typeof useEmbeddingModels>
