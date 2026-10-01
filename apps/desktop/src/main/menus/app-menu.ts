import { mkdirSync } from 'node:fs'

import type { Language } from '@milibot/shared'
import { app, BrowserWindow, dialog, Menu, shell } from 'electron'

import { mainText } from '../app/i18n'
import type { DaemonManager } from '../daemon/manager'
import { appPaths } from '../daemon/paths'
import { menuTemplate } from './template'

export async function confirmAndStopService(daemon: DaemonManager, language: Language): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: mainText(language, 'stopServiceTitle'),
    detail: mainText(language, 'stopServiceDetail'),
    buttons: [mainText(language, 'stopServiceConfirm'), mainText(language, 'stopServiceCancel')],
    defaultId: 1,
    cancelId: 1,
  })
  if (response !== 0) return
  const windows = BrowserWindow.getAllWindows()
  for (const window of windows) window.hide()
  if (await daemon.stop()) {
    app.quit()
    return
  }
  for (const window of windows) if (!window.isDestroyed()) window.show()
  dialog.showErrorBox(mainText(language, 'stopServiceTitle'), mainText(language, 'stopServiceFailed'))
}

export function showLogs(): void {
  const { logsDir } = appPaths()
  mkdirSync(logsDir, { recursive: true })
  void shell.openPath(logsDir)
}

/** Idempotent: the menu is rebuilt when the app language changes. */
export function installAppMenu(daemon: DaemonManager, language: Language): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(process.platform, language, app.name, {
        stopService: daemon.external ? undefined : () => void confirmAndStopService(daemon, language),
        showLogs,
        devTools: !app.isPackaged,
      }),
    ),
  )
}
