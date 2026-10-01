import type { ConversationMemorySummary } from '@milibot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { api, subscribeWorkspaceEvents } from '@/api/daemon'
import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'

const CALLS_LIMIT = 300
const REFRESH_DEBOUNCE_MS = 800

/** A conversation's debug totals and LLM calls, refetched (debounced) after every LLM call of the workspace. */
export function useConversationDebug(workspaceId: string | null, conversationId: string | null) {
  const query = useApiQuery(
    queryKeys.conversationDebug(workspaceId ?? '', conversationId ?? ''),
    async () => {
      const params = { workspaceId: workspaceId ?? '', conversationId: conversationId ?? '' }
      const [debug, calls] = await Promise.all([
        api().call('getConversationDebug', { params }),
        api().call('listLlmCalls', { params, query: { limit: CALLS_LIMIT, payloads: 'false' } }),
      ])
      return { conversationId: params.conversationId, debug, calls }
    },
    { enabled: Boolean(workspaceId && conversationId) },
  )
  const client = useQueryClient()
  useEffect(() => {
    if (!workspaceId || !conversationId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeWorkspaceEvents((_workspaceId, event) => {
      if (event.type !== 'workspace.status') return
      clearTimeout(timer)
      timer = setTimeout(
        () =>
          void client.invalidateQueries({
            queryKey: queryKeys.conversationDebug(workspaceId, conversationId),
            exact: true,
          }),
        REFRESH_DEBOUNCE_MS,
      )
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [client, workspaceId, conversationId])
  return query
}

export function useConversationSummaries(workspaceId: string | null, conversationId: string, botId: string) {
  return useApiQuery(
    queryKeys.conversationSummaries(workspaceId ?? '', conversationId, botId),
    () =>
      api()
        .call('listConversationSummaries', {
          params: { workspaceId: workspaceId ?? '', conversationId },
          query: { botId, active: 'true' },
        })
        .catch((): ConversationMemorySummary[] => []),
    { enabled: Boolean(workspaceId) },
  )
}

export function useLlmCall(workspaceId: string | null, callId: string) {
  return useApiQuery(
    queryKeys.llmCall(workspaceId ?? '', callId),
    () => api().call('getLlmCall', { params: { workspaceId: workspaceId ?? '', callId } }),
    { enabled: Boolean(workspaceId) },
  )
}

/** Tools a turn ran, oldest first (empty when they can't be read). */
export function useTurnToolCalls(workspaceId: string | null, conversationId: string, turnId: string | null) {
  return useApiQuery(
    queryKeys.toolCalls(workspaceId ?? '', conversationId, turnId ?? ''),
    async () => {
      const rows = await api()
        .call('listToolCalls', {
          params: { workspaceId: workspaceId ?? '', conversationId },
          query: { limit: 500, turnId: turnId ?? '' },
        })
        .catch(() => [])
      return rows.filter((r) => !r.hidden).reverse()
    },
    { enabled: Boolean(workspaceId && turnId) },
  )
}
