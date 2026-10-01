import { byRecentlyOpened, type Language, type WorkspaceSummary } from '@milibot/shared'
import type { MenuItemConstructorOptions } from 'electron'

import { mainText } from '../app/i18n'

/** What the tray shows: the workspaces (null: the daemon did not answer) and whether it is starting. */
export interface TrayState {
  workspaces: WorkspaceSummary[] | null
  starting: boolean
}

export interface TrayActions {
  openWorkspace(workspaceId: string): void
  showLogs(): void
  quit(): void
}

function statusLabel(language: Language, state: TrayState): string {
  if (state.workspaces) {
    const count = state.workspaces.filter((w) => w.runtimeStatus === 'running').length
    return mainText(language, 'trayStatusActive', { count })
  }
  return mainText(language, state.starting ? 'trayStatusStarting' : 'trayStatusStopped')
}

/**
 * Linux and Windows keep the app in the tray while the daemon works in the background: open a
 * workspace, see the service status, quit (which also stops the daemon).
 */
export function trayMenuTemplate(
  language: Language,
  appName: string,
  state: TrayState,
  actions: TrayActions,
): MenuItemConstructorOptions[] {
  const workspaces = [...(state.workspaces ?? [])].sort(byRecentlyOpened)
  return [
    {
      label: mainText(language, 'trayOpenWorkspace'),
      submenu: workspaces.length
        ? workspaces.map((workspace) => ({
            label: workspace.name,
            click: () => actions.openWorkspace(workspace.id),
          }))
        : [{ label: mainText(language, 'trayNoWorkspaces'), enabled: false }],
    },
    { type: 'separator' },
    { label: statusLabel(language, state), enabled: false },
    { label: mainText(language, 'trayShowLogs'), click: actions.showLogs },
    { type: 'separator' },
    { label: mainText(language, 'trayQuit', { app: appName }), click: actions.quit },
  ]
}
