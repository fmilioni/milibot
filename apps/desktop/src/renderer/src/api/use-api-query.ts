import { type QueryKey, useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'

export interface ApiQuery<T> {
  data: T | null
  error: unknown
  /** No data yet and a request in flight. */
  loading: boolean
  reload: () => void
}

interface ApiQueryOptions {
  /** false: nothing is fetched (e.g. the VM is off); `data` stays null. */
  enabled?: boolean
  /** Refetches every `ms` while mounted (e.g. an install in progress). */
  refetchInterval?: number | false
  /** How long an answer is reused by components mounting later, in ms (default 0: refetched on mount). */
  staleTime?: number
}

/**
 * Server data under `key` (a `queryKeys` entry): fetched when first shown, shared by every component
 * reading the same key, refetched when an event or a mutation invalidates it.
 */
export function useApiQuery<T>(
  key: QueryKey,
  load: () => Promise<T>,
  { enabled = true, refetchInterval = false, staleTime = 0 }: ApiQueryOptions = {},
): ApiQuery<T> {
  const query = useQuery({ queryKey: key, queryFn: load, enabled, refetchInterval, staleTime })
  const { refetch } = query
  const reload = useCallback(() => void refetch(), [refetch])
  return { data: query.data ?? null, error: query.error, loading: query.isLoading, reload }
}
