import type { Procedure, Routine, UpdateProcedureBody } from '@milibot/shared'

import { api } from '@/api/daemon'
import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'

interface RoutineFields {
  name: string
  prompt: string
  cron: string
}

/** A bot's routines (empty when they can't be read); `routine.*` events patch the cached list. */
export function useBotRoutines(workspaceId: string | null, botId: string) {
  return useApiQuery(
    queryKeys.routines(workspaceId ?? '', botId),
    () =>
      api()
        .call('listRoutines', { params: { workspaceId: workspaceId ?? '' }, query: { botId } })
        .catch((): Routine[] => []),
    { enabled: Boolean(workspaceId) },
  )
}

export const createRoutine = (workspaceId: string, botId: string, body: RoutineFields) =>
  api().call('createRoutine', { params: { workspaceId, botId }, body })

export const updateRoutine = (
  workspaceId: string,
  routineId: string,
  body: Partial<RoutineFields> & { enabled?: boolean },
) => api().call('updateRoutine', { params: { workspaceId, routineId }, body })

export const runRoutine = (workspaceId: string, routineId: string) =>
  api().call('runRoutine', { params: { workspaceId, routineId } })

export const deleteRoutine = (workspaceId: string, routineId: string) =>
  api().call('deleteRoutine', { params: { workspaceId, routineId } })

/** The procedures a bot can use (empty when they can't be read); refetched on `procedure.*`. */
export function useBotProcedures(workspaceId: string | null, botId: string) {
  return useApiQuery(
    queryKeys.procedures(workspaceId ?? '', botId),
    () =>
      api()
        .call('listProcedures', { params: { workspaceId: workspaceId ?? '' }, query: { botId } })
        .catch((): Procedure[] => []),
    { enabled: Boolean(workspaceId) },
  )
}

export const updateProcedure = (workspaceId: string, procedureId: string, body: UpdateProcedureBody) =>
  api().call('updateProcedure', { params: { workspaceId, procedureId }, body })

export const deleteProcedure = (workspaceId: string, procedureId: string) =>
  api().call('deleteProcedure', { params: { workspaceId, procedureId } })

export function useBotMemories(workspaceId: string | null, botId: string) {
  return useApiQuery(
    queryKeys.botMemories(workspaceId ?? '', botId),
    () => api().call('listBotMemories', { params: { workspaceId: workspaceId ?? '', botId } }),
    { enabled: Boolean(workspaceId) },
  )
}

export const createBotMemory = (workspaceId: string, botId: string, content: string) =>
  api().call('createBotMemory', { params: { workspaceId, botId }, body: { content, pinned: true } })

export const updateBotMemory = (
  workspaceId: string,
  botId: string,
  memoryId: string,
  body: { content?: string; pinned?: boolean },
) => api().call('updateBotMemory', { params: { workspaceId, botId, memoryId }, body })

export const deleteBotMemory = (workspaceId: string, botId: string, memoryId: string) =>
  api().call('deleteBotMemory', { params: { workspaceId, botId, memoryId } })

/** Versions of a bot's prompt; refetched on `bot.updated`. */
export function usePromptVersions(workspaceId: string, botId: string) {
  return useApiQuery(queryKeys.promptVersions(workspaceId, botId), () =>
    api().call('listPromptVersions', { params: { workspaceId, botId } }),
  )
}

export const restorePromptVersion = (workspaceId: string, botId: string, versionId: string) =>
  api().call('restorePromptVersion', { params: { workspaceId, botId, versionId } })

export const undoPromptVersion = (workspaceId: string, versionId: string) =>
  api().call('undoPromptVersion', { params: { workspaceId, versionId } })
