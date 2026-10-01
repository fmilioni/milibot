import { app, nativeTheme, session } from 'electron'

import { systemLanguage } from './app/i18n'
import { AppLifecycle, prepareApp } from './app/lifecycle'
import { launchMode, runDaemonMode } from './app/modes'
import { AppSettingsWatcher } from './app/settings'
import { DaemonManager } from './daemon/manager'
import { registerIpc } from './ipc/register'
import { NotificationCenter } from './services/notifications/center'
import { VncBridge } from './services/vnc-bridge'
import { applyPermissionPolicy } from './windows/permissions'
import { workspaceFocus } from './windows/registry'
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
  registerIpc({ daemon, vncBridge, settings })
  new NotificationCenter({
    settings,
    focus: workspaceFocus,
    open: (workspaceId, conversationId) =>
      void daemon
        .client()
        .then((client) => showConversation(client, workspaceId, conversationId))
        .catch((err: unknown) => console.error('[main] showConversation failed', err)),
  })
  new AppLifecycle({ daemon, settings, vncBridge }).start()
  settings.start()
}
