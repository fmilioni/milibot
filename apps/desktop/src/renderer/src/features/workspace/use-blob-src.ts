import { useQuery } from '@tanstack/react-query'

import { queryKeys } from '@/api/queries'

import { loadBlobSrc } from './api'
import { useAppStore } from './store'

/** A blob as a data URL; blobs never change, so each sha is fetched once. */
export function useBlobSrc(sha: string | null | undefined): string | null {
  const workspaceId = useAppStore((s) => s.workspaceId)
  const { data } = useQuery({
    queryKey: queryKeys.blob(workspaceId ?? '', sha ?? ''),
    queryFn: () => loadBlobSrc(workspaceId ?? '', sha ?? ''),
    enabled: Boolean(workspaceId && sha),
    staleTime: Infinity,
  })
  return sha ? (data ?? null) : null
}
