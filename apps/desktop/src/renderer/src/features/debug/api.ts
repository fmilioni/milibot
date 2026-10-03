import type { ConversationMemorySummary } from '@milibot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { api, subscribeWorkspaceEvents } from '@/api/daemon'
import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'

const CALLS_LIMIT = 300
/** At most one reload per this long while calls keep coming (a running CLI turn writes every ~1.5 s). */
const REFRESH_THROTTLE_MS = 500

/**
 * A conversation's debug totals and LLM calls, reloaded (throttled, never starved by a steady stream) each time
 * one of its calls is recorded or a running one moves on; the payload and tools of those calls reload too, so an
 * open turn stays current. Data on screen stays while it reloads.
 */
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
    let last = Number.NEGATIVE_INFINITY
    /** Calls written since the last reload, with their turn. */
    const touched = new Map<string, string | null>()
    const refresh = () => {
      timer = undefined
      last = Date.now()
      const invalidate = (queryKey: readonly unknown[]) =>
        void client.invalidateQueries({ queryKey, exact: true })
      invalidate(queryKeys.conversationDebug(workspaceId, conversationId))
      for (const [callId, turnId] of touched) {
        invalidate(queryKeys.llmCall(workspaceId, callId))
        if (turnId) invalidate(queryKeys.toolCalls(workspaceId, conversationId, turnId))
      }
      touched.clear()
    }
    const unsubscribe = subscribeWorkspaceEvents((eventWorkspaceId, event) => {
      if (eventWorkspaceId !== workspaceId || event.type !== 'llm_call.recorded') return
      if (event.payload.conversationId !== conversationId) return
      touched.set(event.payload.callId, event.payload.turnId)
      timer ??= setTimeout(refresh, Math.max(0, last + REFRESH_THROTTLE_MS - Date.now()))
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
