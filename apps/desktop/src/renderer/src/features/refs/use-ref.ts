import { type RefInfo, refKindOf } from '@milibot/shared'
import { useQuery } from '@tanstack/react-query'

import { queryKeys } from '@/api/queries'
import { useAppStore } from '@/features/workspace/store'

import { loadRef } from './api'

/** What an id stands for now: undefined while loading (or failed), null when it doesn't exist. */
export function useRefInfo(id: string): RefInfo | null | undefined {
  const workspaceId = useAppStore((s) => s.workspaceId)
  const kind = refKindOf(id)
  const query = useQuery({
    queryKey: queryKeys.ref(workspaceId ?? '', kind ?? '', id),
    queryFn: () => loadRef(workspaceId as string, id),
    enabled: Boolean(workspaceId && kind),
    // Events keep names current (`cache-updates.ts`), so the answer is never refetched on its own.
    staleTime: Infinity,
  })
  return query.data
}
