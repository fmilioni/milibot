import type { AppEvent, RefInfo, RefKind, Routine, WorkspaceEvent } from '@milibot/shared'
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

/** A renamed item shows its new name wherever its id is linked in text. */
function renameRef(workspaceId: string, kind: RefKind, id: string, name: string): CacheUpdate {
  return {
    kind: 'update',
    key: queryKeys.ref(workspaceId, kind, id),
    update: (current) => (current ? { ...(current as RefInfo), name } : current),
  }
}

const goneRef = (workspaceId: string, kind: RefKind, id: string) =>
  replace(queryKeys.ref(workspaceId, kind, id), null)

/** What an event changes in the names of the ids linked in text (`features/refs`). */
function refUpdates(workspaceId: string, event: WorkspaceEvent): CacheUpdate[] {
  const ws = workspaceId
  switch (event.type) {
    case 'board.updated':
      return [renameRef(ws, 'board', event.payload.board.id, event.payload.board.title)]
    case 'board.deleted':
      return [goneRef(ws, 'board', event.payload.boardId), invalidate(queryKeys.refs(ws, 'card'))]
    // Cards removed or moved to another board aren't named in the event: the cards on screen ask again.
    case 'board.cards.updated':
      return [invalidate(queryKeys.refs(ws, 'card'))]
    case 'design.updated':
      return [renameRef(ws, 'design', event.payload.design.id, event.payload.design.name)]
    case 'design.deleted':
      return [goneRef(ws, 'design', event.payload.designId), invalidate(queryKeys.refs(ws, 'frame'))]
    case 'design.frame.updated': {
      const { frame, deleted } = event.payload
      return [deleted ? goneRef(ws, 'frame', frame.id) : renameRef(ws, 'frame', frame.id, frame.name)]
    }
    case 'plan.updated':
      return [renameRef(ws, 'plan', event.payload.plan.id, event.payload.plan.title)]
    case 'plan.deleted':
      return [goneRef(ws, 'plan', event.payload.planId)]
    case 'work_session.updated':
      return [renameRef(ws, 'session', event.payload.session.id, event.payload.session.title)]
    case 'work_session.deleted':
      return [goneRef(ws, 'session', event.payload.sessionId)]
    case 'knowledge.doc.updated':
      return [renameRef(ws, 'doc', event.payload.doc.id, event.payload.doc.title)]
    case 'knowledge.doc.deleted':
      return [goneRef(ws, 'doc', event.payload.docId)]
    case 'project.updated':
      return [renameRef(ws, 'project', event.payload.project.id, event.payload.project.name)]
    case 'project.deleted':
      return [goneRef(ws, 'project', event.payload.projectId)]
    case 'skill.updated':
      return [renameRef(ws, 'skill', event.payload.skill.id, event.payload.skill.slug)]
    case 'skill.deleted':
      return [goneRef(ws, 'skill', event.payload.skillId)]
    case 'routine.updated':
      return [renameRef(ws, 'routine', event.payload.routine.id, event.payload.routine.name)]
    case 'routine.deleted':
      return [goneRef(ws, 'routine', event.payload.routineId)]
    // Conversations without a title are named after their bots.
    case 'bot.updated':
      return [
        renameRef(ws, 'bot', event.payload.bot.id, event.payload.bot.name),
        invalidate(queryKeys.refs(ws, 'conversation')),
      ]
    case 'bot.deleted':
      return [goneRef(ws, 'bot', event.payload.botId), invalidate(queryKeys.refs(ws, 'conversation'))]
    case 'conversation.updated': {
      const { id, title } = event.payload.conversation
      return title ? [renameRef(ws, 'conversation', id, title)] : []
    }
    case 'conversation.deleted':
      return [goneRef(ws, 'conversation', event.payload.conversationId)]
    default:
      return []
  }
}

/** The WS invalidation map: the queries a workspace event makes stale (stores follow their own events). */
export function workspaceCacheUpdates(workspaceId: string, event: WorkspaceEvent): CacheUpdate[] {
  return [...ownUpdates(workspaceId, event), ...refUpdates(workspaceId, event)]
}

function ownUpdates(workspaceId: string, event: WorkspaceEvent): CacheUpdate[] {
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
    case 'bot.screen':
      return [invalidate(queryKeys.botDisplay(workspaceId, event.payload.botId))]
    case 'set_aside.changed':
      return [invalidate(queryKeys.setAside(workspaceId, event.payload.botId))]
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
