import {
  type ApiClient,
  createApiClient,
  WORKSPACE_EVENTS_PATH,
  type WorkspaceEvent,
  WorkspaceEventEnvelope,
  type WorkspaceSummary,
} from '@milibot/shared'
import WebSocket from 'ws'

import type { DaemonConnection } from '../../bridge/contract'
import { type AppSettingsWatcher, backoff, parseFrame, socketUrl } from '../app/settings'

export interface WorkspaceEventSubscriber {
  /** Every event of the workspace's socket; the first one after it opens is `runtime.status`. */
  event(workspaceId: string, event: WorkspaceEvent): void
  /** The workspace's socket closed (it reconnects): what it reported may be stale until then. */
  disconnected?(workspaceId: string): void
  /** The workspace is no longer followed (deleted). */
  removed?(workspaceId: string): void
}

interface WorkspaceState {
  name: string
  socket: WebSocket | null
  retry: number
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * One socket per workspace on the daemon's `/w/:ws/events`, opened for every workspace whether a window
 * shows it or not, shared by the main-process services that follow workspace events. Opening the socket
 * never starts a runtime.
 */
export class WorkspaceEventFeed {
  private apiClient: ApiClient | null = null
  private connection: DaemonConnection | null = null
  private readonly workspaces = new Map<string, WorkspaceState>()
  private readonly subscribers = new Set<WorkspaceEventSubscriber>()

  constructor(settings: AppSettingsWatcher) {
    settings.onWorkspaces({
      reset: (workspaces, connection) => this.reset(workspaces, connection),
      upsert: (workspace) => this.track(workspace.id, workspace.name),
      remove: (workspaceId) => this.drop(workspaceId),
    })
  }

  /** The daemon's client, once the app socket has connected. */
  get client(): ApiClient | null {
    return this.apiClient
  }

  workspaceName(workspaceId: string): string | undefined {
    return this.workspaces.get(workspaceId)?.name
  }

  subscribe(subscriber: WorkspaceEventSubscriber): void {
    this.subscribers.add(subscriber)
  }

  private reset(workspaces: WorkspaceSummary[], connection: DaemonConnection): void {
    this.connection = connection
    this.apiClient = createApiClient(connection)
    const ids = new Set(workspaces.map((w) => w.id))
    for (const id of [...this.workspaces.keys()]) if (!ids.has(id)) this.drop(id)
    for (const workspace of workspaces) this.track(workspace.id, workspace.name)
    for (const [id, state] of this.workspaces) if (!state.socket) this.connectWorkspace(id)
  }

  private track(workspaceId: string, name: string): void {
    const current = this.workspaces.get(workspaceId)
    if (current) {
      current.name = name
      return
    }
    this.workspaces.set(workspaceId, { name, socket: null, retry: 0, timer: null })
    this.connectWorkspace(workspaceId)
  }

  private drop(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    this.workspaces.delete(workspaceId)
    if (state.timer) clearTimeout(state.timer)
    state.socket?.close()
    this.notify((subscriber) => subscriber.removed?.(workspaceId))
  }

  /** A subscriber that throws would otherwise throw inside a socket handler (an error dialog in main). */
  private notify(call: (subscriber: WorkspaceEventSubscriber) => void): void {
    for (const subscriber of this.subscribers) {
      try {
        call(subscriber)
      } catch (err) {
        console.warn('[workspace-events] subscriber failed', err)
      }
    }
  }

  private connectWorkspace(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state || !this.connection) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    const previous = state.socket
    const socket = new WebSocket(
      socketUrl(this.connection, WORKSPACE_EVENTS_PATH.replace(':workspaceId', workspaceId)),
    )
    state.socket = socket
    previous?.close()
    socket.on('open', () => {
      state.retry = 0
    })
    socket.on('message', (data) => {
      const parsed = WorkspaceEventEnvelope.safeParse(parseFrame(data))
      if (!parsed.success || this.workspaces.get(workspaceId) !== state) return
      this.notify((subscriber) => subscriber.event(workspaceId, parsed.data.event))
    })
    socket.on('error', () => undefined)
    socket.on('close', (code) => {
      if (state.socket !== socket) return
      state.socket = null
      if (this.workspaces.get(workspaceId) !== state) return
      this.notify((subscriber) => subscriber.disconnected?.(workspaceId))
      // 4404: the workspace no longer exists.
      if (code === 4404) return
      state.timer = setTimeout(() => this.connectWorkspace(workspaceId), backoff(state.retry++))
    })
  }
}
