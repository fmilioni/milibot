import { QueryClient } from '@tanstack/react-query'

/**
 * Server data is refetched when a screen mounts (cached data shows meanwhile) and when an event or a
 * mutation invalidates it (`cache-updates.ts`); never on window focus, never retried.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
      mutations: { retry: false },
    },
  })
}

export const queryClient = createQueryClient()
