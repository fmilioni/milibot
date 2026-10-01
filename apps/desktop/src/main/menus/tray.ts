import type { Language, WorkspaceSummary } from '@milibot/shared'
import { app, Menu, nativeImage, Tray } from 'electron'

import trayIcon from '../../../build/tray.png?asset'
import { type TrayActions, trayMenuTemplate } from './tray-menu'

/** Linux trays (AppIndicator) never report opening the menu, so it is refreshed on a timer. */
const REFRESH_MS = 5_000

export interface AppTrayDeps extends TrayActions {
  /** Null when the daemon does not answer. */
  listWorkspaces(): Promise<WorkspaceSummary[] | null>
  isStarting(): boolean
  /** Clicking the icon (Windows; some Linux trays): open the most recent workspace. */
  activate(): void
}

/**
 * The tray icon on Linux and Windows, where closing the last window leaves the app running in the
 * tray (the daemon keeps working). macOS keeps the app in the Dock instead and has no tray.
 */
export class AppTray {
  private tray: Tray | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private language: Language
  private workspaces: WorkspaceSummary[] | null = null
  private lastMenu = ''

  constructor(
    private readonly deps: AppTrayDeps,
    language: Language,
  ) {
    this.language = language
  }

  /** False when the desktop has no tray (then the app quits with its last window). */
  start(): boolean {
    try {
      const image = nativeImage.createFromPath(trayIcon).resize({ width: 22, height: 22 })
      this.tray = new Tray(image)
    } catch (err) {
      console.warn('[tray] not available', err)
      return false
    }
    this.tray.setToolTip(app.name)
    this.tray.on('click', () => this.deps.activate())
    this.render()
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
    return true
  }

  setLanguage(language: Language): void {
    this.language = language
    this.render()
  }

  async refresh(): Promise<void> {
    this.workspaces = await this.deps.listWorkspaces().catch(() => null)
    this.render()
  }

  private render(): void {
    if (!this.tray) return
    const template = trayMenuTemplate(
      this.language,
      app.name,
      { workspaces: this.workspaces, starting: this.deps.isStarting() },
      this.deps,
    )
    // Rebuilding an unchanged menu makes some Linux trays flicker or close it while open.
    const key = JSON.stringify(template, (k, v: unknown) => (k === 'click' ? undefined : v))
    if (key === this.lastMenu) return
    this.lastMenu = key
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.tray?.destroy()
    this.tray = null
  }
}
