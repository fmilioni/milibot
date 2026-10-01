import {
  type ApiClient,
  type AppEvent,
  AppEventEnvelope,
  buildPath,
  createApiClient,
  EVENTS_PATH,
  WORKSPACE_EVENTS_PATH,
  type WorkspaceEvent,
  WorkspaceEventEnvelope,
} from '@milibot/shared'

import type { DaemonConnection } from '../../../bridge/contract'
import { openEventStream } from './events'

type WorkspaceListener = (workspaceId: string, event: WorkspaceEvent) => void
type AppListener = (event: AppEvent) => void

let connection: DaemonConnection | null = null
let client: ApiClient | null = null
let refreshing: Promise<void> | null = null
let closeWorkspaceStream: (() => void) | null = null
let closeAppStream: (() => void) | null = null
const workspaceListeners = new Set<WorkspaceListener>()
const appListeners = new Set<AppListener>()

export function api(): ApiClient {
  if (!client) throw new Error('Daemon connection not initialized')
  return client
}

export function connectDaemon(next: DaemonConnection): void {
  connection = next
  client = createApiClient(next)
}

/** Asks the main process for the daemon again (it may have restarted on another port or token). */
function refreshConnection(): Promise<void> {
  refreshing ??= window.milibot
    .getContext()
    .then((ctx) => connectDaemon(ctx.daemon))
    .catch(() => undefined)
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

/** Other stores follow the app event stream through this (e.g. the golden image build). */
export function subscribeAppEvents(listener: AppListener): () => void {
  appListeners.add(listener)
  return () => appListeners.delete(listener)
}

/** Other stores follow the workspace event stream through this (e.g. MCP servers). */
export function subscribeWorkspaceEvents(listener: WorkspaceListener): () => void {
  workspaceListeners.add(listener)
  return () => workspaceListeners.delete(listener)
}

/** Hands an event to the subscribers as if the stream had delivered it (the dev hook). */
export function emitWorkspaceEvent(workspaceId: string, event: WorkspaceEvent): void {
  for (const listener of workspaceListeners) listener(workspaceId, event)
}

const currentConnection = () => connection as DaemonConnection

/**
 * Follows `workspaceId`'s events, replacing the stream followed before. Events reach `apply` (the app
 * store) before the subscribers, and only while `isCurrent` holds for the envelope's workspace.
 */
export function followWorkspaceEvents(
  workspaceId: string,
  handlers: {
    isCurrent: (workspaceId: string | null) => boolean
    apply: (event: WorkspaceEvent) => void
    onOpen: () => void
    onClose: () => void
  },
): void {
  closeWorkspaceStream?.()
  closeWorkspaceStream = openEventStream({
    connection: currentConnection,
    path: buildPath(WORKSPACE_EVENTS_PATH, { workspaceId }),
    onFrame: (frame) => {
      const parsed = WorkspaceEventEnvelope.safeParse(frame)
      if (!parsed.success || !handlers.isCurrent(parsed.data.workspaceId)) return
      handlers.apply(parsed.data.event)
      for (const listener of workspaceListeners) listener(workspaceId, parsed.data.event)
    },
    onOpen: handlers.onOpen,
    onClose: () => {
      handlers.onClose()
      void refreshConnection()
    },
  })
}

/** Follows the app events, replacing the stream followed before; `apply` runs before the subscribers. */
export function followAppEvents(apply: (event: AppEvent) => void): void {
  closeAppStream?.()
  closeAppStream = openEventStream({
    connection: currentConnection,
    path: EVENTS_PATH,
    onFrame: (frame) => {
      const parsed = AppEventEnvelope.safeParse(frame)
      if (!parsed.success) return
      apply(parsed.data.event)
      for (const listener of appListeners) listener(parsed.data.event)
    },
  })
}
