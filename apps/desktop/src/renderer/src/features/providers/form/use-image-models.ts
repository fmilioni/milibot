import type { ImageModelCandidate, ImageModelCandidates, ProviderDraft, ProviderModel } from '@milibot/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { providerDraft } from '@/features/providers/api'
import {
  type ImageRow,
  imageRowFromModel,
  mergeImageCandidates,
} from '@/features/providers/lib/provider-form'
import { errorMessage } from '@/lib/errors'

/** The provider form's image models: rows and the server listing to pick from. */
export function useImageModels({
  workspaceId,
  draft,
  saved,
}: {
  workspaceId: string
  draft: () => ProviderDraft
  saved: ProviderModel[]
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ImageRow[]>(() => saved.map(imageRowFromModel))
  const [listing, setListing] = useState<ImageModelCandidates | null>(null)
  const [fetching, setFetching] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const fetchList = async () => {
    setFetching(true)
    setNote(null)
    try {
      setListing(await providerDraft.fetchImageModels(workspaceId, draft()))
    } catch (err) {
      setNote(t('settings.providers.image.fetchFailed', { error: errorMessage(err) }))
    } finally {
      setFetching(false)
    }
  }

  return {
    rows,
    setRows,
    listing,
    closeListing: () => setListing(null),
    addPicked: (picked: ImageModelCandidate[]) => {
      setRows((current) => mergeImageCandidates(current, picked))
      setListing(null)
    },
    fetching,
    note,
    fetchList,
  }
}

export type ImageModels = ReturnType<typeof useImageModels>
