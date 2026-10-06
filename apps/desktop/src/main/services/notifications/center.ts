import type { ApiClient, WorkspaceEvent } from '@milibot/shared'
import { Notification } from 'electron'

import type { AppSettingsWatcher } from '../../app/settings'
import type { WorkspaceEventFeed } from '../workspace-events'
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
  feed: WorkspaceEventFeed
  focus(workspaceId: string): WorkspaceFocus
  open(workspaceId: string, conversationId: string): void
}

/**
 * Desktop notifications for every workspace, fed by the daemon's WebSocket events (open windows or
 * not): replies to the user, bots that need the user and routine runs. Only reads what a runtime
 * that is already running reports, so it never starts one.
 */
export class NotificationCenter {
  /** Bot names per workspace, loaded when its runtime first reports something worth a notification. */
  private readonly botNamesByWorkspace = new Map<string, Map<string, string>>()
  private pending: NotifyCandidate[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Shown notifications keep their click handlers only while referenced. */
  private readonly shown = new Set<Notification>()

  constructor(private readonly deps: NotificationCenterDeps) {
    deps.feed.subscribe({
      event: (workspaceId, event) => void this.handle(workspaceId, event),
      removed: (workspaceId) => this.botNamesByWorkspace.delete(workspaceId),
    })
  }

  private async botNames(client: ApiClient, workspaceId: string): Promise<Map<string, string>> {
    const known = this.botNamesByWorkspace.get(workspaceId)
    if (known) return known
    const bots = await client.call('listBots', { params: { workspaceId } })
    const names = new Map(bots.map((b) => [b.id, b.name]))
    this.botNamesByWorkspace.set(workspaceId, names)
    return names
  }

  private async handle(workspaceId: string, event: WorkspaceEvent): Promise<void> {
    if (event.type === 'bot.created' || event.type === 'bot.updated')
      this.botNamesByWorkspace.get(workspaceId)?.set(event.payload.bot.id, event.payload.bot.name)
    if (event.type === 'runtime.status' && event.payload.status !== 'running')
      this.botNamesByWorkspace.delete(workspaceId)
    const client = this.deps.feed.client
    if (!isNotificationCandidate(event) || !client) return
    try {
      const names = await this.botNames(client, workspaceId)
      const candidate = classifyEvent(event, {
        workspaceId,
        language: this.deps.settings.language,
        botName: (id) => names.get(id) ?? null,
        workspaceName: this.deps.feed.workspaceName(workspaceId) ?? '',
      })
      if (!candidate) return
      const preferences = await client.call('getWorkspacePreferences', { params: { workspaceId } })
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
