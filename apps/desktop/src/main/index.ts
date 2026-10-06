import { app, nativeTheme, powerSaveBlocker, session } from 'electron'

import { systemLanguage } from './app/i18n'
import { AppLifecycle, prepareApp } from './app/lifecycle'
import { launchMode, runDaemonMode } from './app/modes'
import { AppSettingsWatcher } from './app/settings'
import { DaemonManager } from './daemon/manager'
import { emit } from './ipc/handle'
import { registerIpc } from './ipc/register'
import { KeepAwakeGuard } from './services/keep-awake/guard'
import { NotificationCenter } from './services/notifications/center'
import { VncBridge } from './services/vnc-bridge'
import { WorkspaceEventFeed } from './services/workspace-events'
import { AppUpdateService } from './update/app-updater'
import { createUpdaterEngine, logUpdate } from './update/engine'
import { applyPermissionPolicy } from './windows/permissions'
import { windowsOf, workspaceFocus } from './windows/registry'
import { showConversation } from './windows/workspace'

prepareApp()
const daemon = new DaemonManager()
const mode = launchMode(process.argv)

if (mode !== 'app') runDaemonMode(mode, daemon)
else if (!app.requestSingleInstanceLock()) app.quit()
else void app.whenReady().then(startApp)

function startApp(): void {
  applyPermissionPolicy(session.defaultSession)
  const settings = new AppSettingsWatcher({
    connection: () => daemon.connection(),
    fallbackLanguage: systemLanguage(app.getLocale()),
  })
  settings.onTheme((theme) => (nativeTheme.themeSource = theme))
  const vncBridge = new VncBridge({
    resolvePort: async (target) =>
      (await (await daemon.client()).call('getBotDisplay', { params: target })).vncPort,
  })
  const feed = new WorkspaceEventFeed(settings)
  const keepAwake = new KeepAwakeGuard({ feed, settings, blocker: powerSaveBlocker })
  keepAwake.onChange((state) => {
    for (const window of windowsOf('workspace')) emit(window.webContents, 'keepAwakeChanged', state)
  })
  const lifecycle = new AppLifecycle({ daemon, settings, vncBridge, keepAwake })
  const appUpdate = new AppUpdateService({
    engine: createUpdaterEngine(),
    beforeInstall: () => lifecycle.prepareUpdateQuit(),
    installFailed: () => lifecycle.updateQuitAborted(),
    log: logUpdate,
  })
  appUpdate.onChange((state) => {
    for (const window of windowsOf('workspace')) emit(window.webContents, 'appUpdateChanged', state)
  })
  registerIpc({ daemon, vncBridge, settings, keepAwake, appUpdate })
  new NotificationCenter({
    settings,
    feed,
    focus: workspaceFocus,
    open: (workspaceId, conversationId) =>
      void daemon
        .client()
        .then((client) => showConversation(client, workspaceId, conversationId))
        .catch((err: unknown) => console.error('[main] showConversation failed', err)),
  })
  lifecycle.start()
  settings.start()
  appUpdate.start()
}
