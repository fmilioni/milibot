import { type ApiClient, byRecentlyOpened, type Language, type WorkspaceSummary } from '@milibot/shared'
import { app, BrowserWindow, dialog, powerMonitor } from 'electron'

import { releaseUserControl, releaseWorkspaces } from '../daemon/control-release'
import type { DaemonManager } from '../daemon/manager'
import { appPaths } from '../daemon/paths'
import { confirmAndStopService, installAppMenu, showLogs } from '../menus/app-menu'
import { AppTray } from '../menus/tray'
import { APP_ID } from '../platform/app-id'
import { hasStatusNotifierWatcher, userNamespacesRestricted } from '../platform/host/probe'
import { appLoginItem } from '../platform/login-item'
import type { KeepAwakeGuard } from '../services/keep-awake/guard'
import type { VncBridge } from '../services/vnc-bridge'
import { hardenWebContents } from '../windows/hardening'
import { onWindowClosed, onWorkspaceReleased, windowCount, workspaceIds } from '../windows/registry'
import { onVmWindowClosed } from '../windows/vm'
import { openWorkspace, openWorkspaceWindow } from '../windows/workspace'
import { botsWorkingText, mainText } from './i18n'
import type { AppSettingsWatcher } from './settings'
import { shutdownDecision } from './shutdown'

/** Screens the user holds go back to their bots when the app quits: nobody is left to drive them. */
const QUIT_RELEASE_TIMEOUT_MS = 1_500

/** Before `ready`, in every launch mode. */
export function prepareApp(): void {
  hardenWebContents()

  // Packaged, Electron's own data (caches, local storage, the single-instance lock) lives inside the
  // data root instead of a sibling "Milibot" folder, so MILIBOT_DATA_DIR isolates a test instance fully.
  if (app.isPackaged) app.setPath('userData', appPaths().electronDir)

  // Windows shows notifications only for an app with an AppUserModelID; packaged, it must match the
  // installer's shortcut. Dev has no shortcut, and Electron recommends the executable path there.
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath)

  // An AppImage cannot ship a SUID sandbox helper, so Chromium's sandbox needs unprivileged user
  // namespaces; where they are restricted (Ubuntu 24.04+) the app would not start at all.
  if (process.platform === 'linux' && process.env.APPIMAGE && userNamespacesRestricted()) {
    app.commandLine.appendSwitch('no-sandbox')
  }
}

/** The first launch creates the default workspace, which opens at the setup screens. */
async function initialWorkspace(client: ApiClient, language: Language): Promise<WorkspaceSummary> {
  const workspaces = await client.call('listWorkspaces', {})
  const [recent] = [...workspaces].sort(byRecentlyOpened)
  if (recent) return recent
  return client.call('createWorkspace', {
    body: { name: mainText(language, 'defaultWorkspaceName'), color: 'violet', setup: true },
  })
}

/** The most recent window the user can see (minimized included), for a relaunch to bring back. */
function lastUserWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed() && (window.isVisible() || window.isMinimized()))
    .at(-1)
}

export interface LifecycleDeps {
  daemon: DaemonManager
  settings: AppSettingsWatcher
  vncBridge: VncBridge
  keepAwake: Pick<KeepAwakeGuard, 'state'>
}

/**
 * The app's windows, menus and tray from launch to quit. The daemon keeps bots working after the app
 * closes; on macOS the app itself stays in the Dock, on Linux and Windows in the tray (without a tray,
 * closing the last window quits the app).
 */
export class AppLifecycle {
  private quitting = false
  private tray: AppTray | null = null

  constructor(private readonly deps: LifecycleDeps) {}

  start(): void {
    const { daemon, settings, vncBridge } = this.deps
    const busyBots = () => this.deps.keepAwake.state.busyBots
    installAppMenu(daemon, settings.language, busyBots)
    settings.onLanguage((language) => {
      installAppMenu(daemon, language, busyBots)
      this.tray?.setLanguage(language)
    })
    this.watchWindows()
    this.startTray()
    this.stopDaemonAtSessionEnd()
    this.askBeforeShutdown()

    app.on('second-instance', () => this.bringBack())
    app.on('activate', () => {
      if (windowCount('workspace') === 0) void this.openInitialWindow()
    })
    app.on('before-quit', (event) => this.beforeQuit(event))
    app.on('will-quit', () => {
      this.tray?.destroy()
      void vncBridge.close()
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin' && !this.tray) app.quit()
    })

    void this.openInitialWindow()
    void Promise.resolve()
      .then(() => appLoginItem().refresh())
      .catch((err: unknown) => console.warn('[main] login item not refreshed', err))
  }

  async openInitialWindow(): Promise<void> {
    const { daemon, settings } = this.deps
    try {
      const client = await daemon.client()
      settings.apply(await client.call('getAppSettings', {}))
      const workspace = await initialWorkspace(client, settings.language)
      openWorkspaceWindow(workspace.id, workspace.name)
      void this.tray?.refresh()
    } catch (err) {
      console.error('[main] startup failed', err)
      const language = settings.language
      dialog.showErrorBox(
        mainText(language, 'daemonFailedTitle'),
        `${mainText(language, 'daemonFailedDetail')}\n\n${err instanceof Error ? err.message : String(err)}`,
      )
      app.quit()
    }
  }

  private bringBack(): void {
    const window = windowCount('workspace') > 0 ? lastUserWindow() : undefined
    if (!window) {
      void this.openInitialWindow()
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /**
   * The updater quits the app right after this and starts the new version: bot screens go back now
   * (`before-quit` won't hold the quit), and the single-instance lock is released so the new version,
   * which may start before this process exits, isn't turned away as a second instance.
   */
  async prepareUpdateQuit(): Promise<void> {
    this.quitting = true
    const ids = workspaceIds()
    if (ids.length > 0) {
      await this.deps.daemon
        .runningClient()
        .then((client) => (client ? releaseWorkspaces(client, ids, QUIT_RELEASE_TIMEOUT_MS) : null))
        .catch((err: unknown) => console.warn('[main] releasing bot screens before the update failed', err))
    }
    app.releaseSingleInstanceLock()
  }

  /** The installer refused to start: the app goes on as before `prepareUpdateQuit`. */
  updateQuitAborted(): void {
    this.quitting = false
    if (!app.requestSingleInstanceLock())
      console.warn('[main] another instance took the lock during the update')
  }

  private beforeQuit(event: Electron.Event): void {
    if (this.quitting) return
    this.quitting = true
    const ids = workspaceIds()
    if (ids.length === 0) return
    event.preventDefault()
    void this.deps.daemon
      .runningClient()
      .then((client) => (client ? releaseWorkspaces(client, ids, QUIT_RELEASE_TIMEOUT_MS) : null))
      .catch((err: unknown) => console.warn('[main] releasing bot screens on quit failed', err))
      .finally(() => app.quit())
  }

  private watchWindows(): void {
    const { daemon, vncBridge } = this.deps
    onWindowClosed(({ webContentsId }) => vncBridge.revokeOwner(webContentsId))

    onVmWindowClosed(({ workspaceId, botId }) => {
      if (this.quitting) return
      void daemon
        .client()
        .then((client) => releaseUserControl(client, workspaceId, botId))
        .catch((err: unknown) => console.warn('[main] releasing the bot screen failed', err))
    })

    // The daemon applies the workspace's close behavior (keep running or suspend the VM).
    onWorkspaceReleased((workspaceId) => {
      void daemon
        .client()
        .then((client) => client.call('closeWorkspace', { params: { workspaceId } }))
        .catch((err: unknown) => console.error('[main] closeWorkspace failed', err))
    })
  }

  /**
   * Linux and Windows: the tray keeps the app reachable after its last window closes. A Linux session
   * without a tray host (stock GNOME) would show no icon, so there the app quits with its last window.
   */
  private startTray(): void {
    if (process.platform === 'darwin') return
    if (process.platform !== 'linux') {
      this.createTray()
      return
    }
    void hasStatusNotifierWatcher().then((found) => {
      if (found === false) console.warn('[tray] no StatusNotifierWatcher in this session; no tray')
      else this.createTray()
    })
  }

  private createTray(): void {
    const { daemon, settings } = this.deps
    const candidate = new AppTray(
      {
        listWorkspaces: async () => (await daemon.runningClient())?.call('listWorkspaces', {}) ?? null,
        isStarting: () => daemon.starting,
        openWorkspace: (workspaceId) =>
          void daemon
            .client()
            .then((client) => openWorkspace(client, workspaceId))
            .catch((err: unknown) => console.error('[main] openWorkspace failed', err)),
        activate: () => void this.openInitialWindow(),
        showLogs,
        quit: () => {
          if (daemon.external) app.quit()
          else void confirmAndStopService(daemon, settings.language, this.deps.keepAwake.state.busyBots)
        },
      },
      settings.language,
    )
    if (candidate.start()) this.tray = candidate
  }

  /**
   * Windows ends a session without signalling windowless processes, so the daemon and its VMs would be
   * killed like a power cut. Every window receives the end-of-session messages (a hidden one keeps
   * that working while only the tray is up), and the first one asks the daemon to stop. While bots
   * work, the query is blocked instead (`shutdownDecision`): Windows then lists the app among those
   * keeping it from shutting down, and only the user going on anyway (`session-end`) stops the daemon.
   */
  private stopDaemonAtSessionEnd(): void {
    if (process.platform !== 'win32') return
    let requested = false
    const stop = () => {
      if (requested) return
      requested = true
      this.deps.daemon.requestShutdown()
    }
    app.on('browser-window-created', (_event, window) => {
      window.on('query-session-end', (event) => {
        if (shutdownDecision('win32', this.deps.keepAwake.state.active, event.reasons) === 'block')
          event.preventDefault()
        else stop()
      })
      window.on('session-end', stop)
    })
    if (this.tray)
      new BrowserWindow({ show: false, skipTaskbar: true, focusable: false, width: 1, height: 1 })
  }

  /**
   * macOS: a shutdown, restart or logout while bots work is cancelled (`preventDefault` makes Electron
   * ignore the system's terminate) and the user is asked. Allowing it quits the app, which lets a
   * shutdown still waiting for it go on.
   */
  private askBeforeShutdown(): void {
    if (process.platform !== 'darwin') return
    let asking = false
    // electron.d.ts types this listener without its event, which Electron passes and lets prevent.
    const onShutdown = (event: Electron.Event) => {
      const { active, busyBots } = this.deps.keepAwake.state
      if (shutdownDecision('darwin', active) !== 'ask') return
      event.preventDefault()
      if (asking) return
      asking = true
      const language = this.deps.settings.language
      void dialog
        .showMessageBox({
          type: 'warning',
          message: mainText(language, 'shutdownBusyTitle'),
          detail: `${botsWorkingText(language, busyBots)} ${mainText(language, 'shutdownBusyDetail')}`,
          buttons: [mainText(language, 'shutdownKeepWorking'), mainText(language, 'shutdownAllow')],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          if (response === 1) app.quit()
        })
        .catch((err: unknown) => console.warn('[main] shutdown dialog failed', err))
        .finally(() => (asking = false))
    }
    powerMonitor.on('shutdown', onShutdown as unknown as () => void)
  }
}
