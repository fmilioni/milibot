import type { BrowserWindow } from 'electron'

import type { WindowKind } from '../../bridge/channels'

export type { WindowKind }

export interface AppWindow {
  kind: WindowKind
  window: BrowserWindow
  workspaceId: string
  /** Identity within its kind: one window per workspace, per bot desktop, per design. */
  key: string
  /** Workspace windows: conversation on screen (null: settings or none), reported by the renderer. */
  conversationId: string | null
}

export interface ClosedWindow {
  webContentsId: number
  kind: WindowKind
  workspaceId: string
  key: string
}
