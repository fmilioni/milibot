import {
  type ApiClient,
  createApiClient,
  WORKSPACE_EVENTS_PATH,
  type WorkspaceEvent,
  WorkspaceEventEnvelope,
  type WorkspaceSummary,
} from '@milibot/shared'
import { Notification } from 'electron'
import WebSocket from 'ws'

import type { DaemonConnection } from '../../../bridge/contract'
import { type AppSettingsWatcher, backoff, parseFrame, socketUrl } from '../../app/settings'
import {
  classifyEvent,
  type GroupedNotification,
  groupNotifications,
  isNotificationCandidate,
  type NotifyCandidate,
  shouldNotify,
  type WorkspaceFocus,
} from './logic'

/** Notifications raised within this window after the first one are shown together. */
const GROUP_WINDOW_MS = 1_500

export interface NotificationCenterDeps {
  settings: AppSettingsWatcher
  focus(workspaceId: string): WorkspaceFocus
  open(workspaceId: string, conversationId: string): void
}

interface WorkspaceState {
  name: string
  socket: WebSocket | null
  retry: number
  timer: ReturnType<typeof setTimeout> | null
  /** Bot names, loaded when the runtime first reports something worth a notification. */
  bots: Map<string, string> | null
}

/**
 * Desktop notifications for every workspace, fed by the daemon's WebSocket events (open windows or
 * not): replies to the user, bots that need the user and routine runs. Only reads what a runtime
 * that is already running reports, so it never starts one.
 */
export class NotificationCenter {
  private client: ApiClient | null = null
  private connection: DaemonConnection | null = null
  private readonly workspaces = new Map<string, WorkspaceState>()
  private pending: NotifyCandidate[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Shown notifications keep their click handlers only while referenced. */
  private readonly shown = new Set<Notification>()

  constructor(private readonly deps: NotificationCenterDeps) {
    deps.settings.onWorkspaces({
      reset: (workspaces, connection) => this.reset(workspaces, connection),
      upsert: (workspace) => this.track(workspace.id, workspace.name),
      remove: (workspaceId) => this.drop(workspaceId),
    })
  }

  private reset(workspaces: WorkspaceSummary[], connection: DaemonConnection): void {
    this.connection = connection
    this.client = createApiClient(connection)
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
    this.workspaces.set(workspaceId, { name, socket: null, retry: 0, timer: null, bots: null })
    this.connectWorkspace(workspaceId)
  }

  private drop(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    this.workspaces.delete(workspaceId)
    if (state.timer) clearTimeout(state.timer)
    state.socket?.close()
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
      if (parsed.success) void this.handle(workspaceId, parsed.data.event)
    })
    socket.on('error', () => undefined)
    socket.on('close', (code) => {
      if (state.socket !== socket) return
      state.socket = null
      // 4404: the workspace no longer exists.
      if (code === 4404 || this.workspaces.get(workspaceId) !== state) return
      state.timer = setTimeout(() => this.connectWorkspace(workspaceId), backoff(state.retry++))
    })
  }

  private async botNames(workspaceId: string, state: WorkspaceState): Promise<Map<string, string>> {
    if (state.bots) return state.bots
    const bots = await (this.client as ApiClient).call('listBots', { params: { workspaceId } })
    state.bots = new Map(bots.map((b) => [b.id, b.name]))
    return state.bots
  }

  private async handle(workspaceId: string, event: WorkspaceEvent): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    if (event.type === 'bot.created' || event.type === 'bot.updated')
      state.bots?.set(event.payload.bot.id, event.payload.bot.name)
    if (event.type === 'runtime.status' && event.payload.status !== 'running') state.bots = null
    if (!isNotificationCandidate(event) || !this.client) return
    try {
      const names = await this.botNames(workspaceId, state)
      const candidate = classifyEvent(event, {
        workspaceId,
        language: this.deps.settings.language,
        botName: (id) => names.get(id) ?? null,
        workspaceName: state.name,
      })
      if (!candidate) return
      const preferences = await this.client.call('getWorkspacePreferences', { params: { workspaceId } })
      const decision = shouldNotify(
        candidate,
        {
          enabled: preferences.notifications,
          mutedBots: new Set(preferences.mutedBots),
          routines: preferences.notifyRoutines,
        },
        this.deps.focus(workspaceId),
      )
      if (decision) this.queue(candidate)
    } catch (err) {
      console.warn('[notifications] event skipped', err instanceof Error ? err.message : err)
    }
  }

  private queue(candidate: NotifyCandidate): void {
    this.pending.push(candidate)
    this.flushTimer ??= setTimeout(() => this.flush(), GROUP_WINDOW_MS)
  }

  private flush(): void {
    this.flushTimer = null
    const items = this.pending
    this.pending = []
    for (const notification of groupNotifications(items, this.deps.settings.language)) this.show(notification)
  }

  private show(item: GroupedNotification): void {
    console.log(`[notifications] ${item.title} — ${item.body.replace(/\n/g, ' / ')}`)
    // Linux without a notification server (or libnotify): skip quietly; the log line above remains.
    if (!Notification.isSupported()) return
    try {
      const notification = new Notification({ title: item.title, body: item.body })
      notification.on('click', () => {
        this.shown.delete(notification)
        this.deps.open(item.workspaceId, item.conversationId)
      })
      notification.on('close', () => this.shown.delete(notification))
      notification.on('failed', (_event, error) => {
        this.shown.delete(notification)
        console.warn(`[notifications] not shown: ${error}`)
      })
      this.shown.add(notification)
      notification.show()
    } catch (err) {
      console.warn('[notifications] not shown', err)
    }
  }
}
