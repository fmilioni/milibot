import type { AppEvent, Routine, WorkspaceEvent } from '@milibot/shared'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import { subscribeAppEvents, subscribeWorkspaceEvents } from './daemon'
import { queryKeys, workspaceKey } from './queries'

/** What an event does to the query cache: refetch a key (and everything under it) or write the new data. */
export type CacheUpdate =
  | { kind: 'invalidate'; key: QueryKey }
  | { kind: 'update'; key: QueryKey; update: (current: unknown) => unknown }

const invalidate = (key: QueryKey): CacheUpdate => ({ kind: 'invalidate', key })
const replace = (key: QueryKey, data: unknown): CacheUpdate => ({ kind: 'update', key, update: () => data })

function patchRoutines(key: QueryKey, change: (routines: Routine[]) => Routine[]): CacheUpdate {
  return {
    kind: 'update',
    key,
    update: (current) => (Array.isArray(current) ? change(current as Routine[]) : current),
  }
}

/** The WS invalidation map: the queries a workspace event makes stale (stores follow their own events). */
export function workspaceCacheUpdates(workspaceId: string, event: WorkspaceEvent): CacheUpdate[] {
  switch (event.type) {
    case 'routine.updated': {
      const { routine } = event.payload
      return [
        patchRoutines(queryKeys.routines(workspaceId, routine.botId), (list) =>
          list.some((r) => r.id === routine.id)
            ? list.map((r) => (r.id === routine.id ? routine : r))
            : [...list, routine],
        ),
      ]
    }
    case 'routine.deleted': {
      const { botId, routineId } = event.payload
      return [
        patchRoutines(queryKeys.routines(workspaceId, botId), (list) =>
          list.filter((r) => r.id !== routineId),
        ),
      ]
    }
    case 'procedure.updated':
    case 'procedure.deleted':
      return [invalidate(workspaceKey(workspaceId, 'procedures'))]
    case 'bot.updated':
      return [invalidate(queryKeys.promptVersions(workspaceId, event.payload.bot.id))]
    case 'skill.updated':
      return [invalidate(queryKeys.skill(workspaceId, event.payload.skill.id))]
    case 'skill.deleted':
      return [invalidate(queryKeys.skill(workspaceId, event.payload.skillId))]
    case 'knowledge.doc.updated':
      return [invalidate(workspaceKey(workspaceId, 'knowledge', event.payload.doc.id))]
    case 'knowledge.doc.deleted':
      return [invalidate(workspaceKey(workspaceId, 'knowledge', event.payload.docId))]
    case 'plan.updated':
      return [invalidate(queryKeys.plan(workspaceId, event.payload.plan.id))]
    case 'plan.deleted':
      return [invalidate(queryKeys.plan(workspaceId, event.payload.planId))]
    case 'board.cards.updated':
      return [invalidate(workspaceKey(workspaceId, 'boards', event.payload.boardId, 'cards'))]
    case 'backup.job':
      return [replace(queryKeys.backupJob(workspaceId), event.payload.job)]
    case 'backup.restore':
      return [replace(queryKeys.backupRestore(workspaceId), event.payload.restore)]
    case 'vm.status':
      return [invalidate(queryKeys.vmDetails(workspaceId)), invalidate(queryKeys.cliInstall(workspaceId))]
    case 'workspace.updated':
      return [invalidate(queryKeys.workspaceOverviews())]
    default:
      return []
  }
}

export function appCacheUpdates(event: AppEvent): CacheUpdate[] {
  switch (event.type) {
    case 'workspace.created':
    case 'workspace.updated':
    case 'workspace.deleted':
      return [invalidate(['app', 'workspaces'])]
    default:
      return []
  }
}

export function applyCacheUpdates(client: QueryClient, updates: CacheUpdate[]): void {
  for (const update of updates) {
    if (update.kind === 'invalidate') void client.invalidateQueries({ queryKey: update.key })
    else client.setQueryData(update.key, (current: unknown) => update.update(current))
  }
}

/** Keeps the query cache current with both event streams (registered once at boot). */
export function followCacheUpdates(client: QueryClient): void {
  subscribeWorkspaceEvents((workspaceId, event) =>
    applyCacheUpdates(client, workspaceCacheUpdates(workspaceId, event)),
  )
  subscribeAppEvents((event) => applyCacheUpdates(client, appCacheUpdates(event)))
}
