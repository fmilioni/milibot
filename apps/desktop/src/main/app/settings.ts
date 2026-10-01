import {
  AppEventEnvelope,
  type AppSettings,
  AUTH_QUERY_PARAM,
  createApiClient,
  EVENTS_PATH,
  type Language,
  type ThemePreference,
  type WorkspaceSummary,
} from '@milibot/shared'
import WebSocket from 'ws'

import type { DaemonConnection } from '../../bridge/contract'

const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

export function socketUrl(connection: DaemonConnection, path: string): string {
  return `${connection.baseUrl.replace(/^http/, 'ws')}${path}?${AUTH_QUERY_PARAM}=${encodeURIComponent(connection.token)}`
}

export function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt)
}

/** A malformed frame would otherwise throw inside the socket handler (an error dialog in main). */
export function parseFrame(data: WebSocket.RawData): unknown {
  try {
    return JSON.parse(String(data))
  } catch {
    return null
  }
}

export interface WorkspaceListener {
  /** The app socket (re)connected: every workspace, and the connection to follow their events. */
  reset(workspaces: WorkspaceSummary[], connection: DaemonConnection): void
  upsert(workspace: Pick<WorkspaceSummary, 'id' | 'name'>): void
  remove(workspaceId: string): void
}

export interface AppSettingsWatcherDeps {
  connection(): Promise<DaemonConnection>
  /** The system's language, until the daemon answers. */
  fallbackLanguage: Language
}

/**
 * The app settings main follows (language for menus, tray, dialogs and notifications; theme for window
 * backgrounds), from the daemon's app WebSocket. The renderer's theme changes come through `setTheme`.
 * Also relays the workspace list events of that socket.
 */
export class AppSettingsWatcher {
  private currentLanguage: Language
  private currentTheme: ThemePreference = 'system'
  private socket: WebSocket | null = null
  private retry = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly languageListeners = new Set<(language: Language) => void>()
  private readonly themeListeners = new Set<(theme: ThemePreference) => void>()
  private readonly workspaceListeners = new Set<WorkspaceListener>()

  constructor(private readonly deps: AppSettingsWatcherDeps) {
    this.currentLanguage = deps.fallbackLanguage
  }

  get language(): Language {
    return this.currentLanguage
  }

  get theme(): ThemePreference {
    return this.currentTheme
  }

  onLanguage(listener: (language: Language) => void): void {
    this.languageListeners.add(listener)
  }

  onTheme(listener: (theme: ThemePreference) => void): void {
    this.themeListeners.add(listener)
  }

  onWorkspaces(listener: WorkspaceListener): void {
    this.workspaceListeners.add(listener)
  }

  start(): void {
    void this.connect()
  }

  apply(settings: Partial<Pick<AppSettings, 'language' | 'theme'>>): void {
    this.setLanguage(settings.language ?? this.deps.fallbackLanguage)
    if (settings.theme) this.setTheme(settings.theme)
  }

  setTheme(theme: ThemePreference): void {
    if (theme === this.currentTheme) return
    this.currentTheme = theme
    for (const listener of this.themeListeners) listener(theme)
  }

  private setLanguage(language: Language): void {
    if (language === this.currentLanguage) return
    this.currentLanguage = language
    for (const listener of this.languageListeners) listener(language)
  }

  private async connect(): Promise<void> {
    try {
      const connection = await this.deps.connection()
      const client = createApiClient(connection)
      const [settings, workspaces] = await Promise.all([
        client.call('getAppSettings', {}),
        client.call('listWorkspaces', {}),
      ])
      this.apply(settings)
      const socket = new WebSocket(socketUrl(connection, EVENTS_PATH))
      this.socket = socket
      socket.on('open', () => {
        this.retry = 0
      })
      socket.on('message', (data) => {
        const parsed = AppEventEnvelope.safeParse(parseFrame(data))
        if (parsed.success) this.handle(parsed.data.event)
      })
      socket.on('error', () => undefined)
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        this.scheduleReconnect()
      })
      for (const listener of this.workspaceListeners) listener.reset(workspaces, connection)
    } catch (err) {
      console.warn('[settings] daemon unavailable', err instanceof Error ? err.message : err)
      this.scheduleReconnect()
    }
  }

  private handle(event: AppEventEnvelope['event']): void {
    if (event.type === 'app_settings.updated') this.apply(event.payload.settings)
    else if (event.type === 'workspace.created' || event.type === 'workspace.updated')
      for (const listener of this.workspaceListeners) listener.upsert(event.payload.workspace)
    else if (event.type === 'workspace.deleted')
      for (const listener of this.workspaceListeners) listener.remove(event.payload.workspaceId)
  }

  private scheduleReconnect(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.connect()
    }, backoff(this.retry++))
  }
}
