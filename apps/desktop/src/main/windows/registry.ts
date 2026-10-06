import type { BrowserWindow } from 'electron'

import type { AppWindow, ClosedWindow, WindowKind } from './types'

const windows = new Map<number, AppWindow>()
const closedListeners = new Set<{ kind?: WindowKind; listener: (closed: ClosedWindow) => void }>()
const releasedListeners = new Set<(workspaceId: string) => void>()

export function registerWindow(entry: Omit<AppWindow, 'conversationId'>): void {
  const webContentsId = entry.window.webContents.id
  windows.set(webContentsId, { ...entry, conversationId: null })
  entry.window.on('closed', () => {
    const current = windows.get(webContentsId)
    windows.delete(webContentsId)
    if (!current) return
    const closed = { webContentsId, kind: current.kind, workspaceId: current.workspaceId, key: current.key }
    for (const { kind, listener } of closedListeners) if (!kind || kind === closed.kind) listener(closed)
    if (closed.kind === 'workspace') notifyIfReleased(closed.workspaceId)
  })
}

function find(kind: WindowKind, key: string): AppWindow | undefined {
  return [...windows.values()].find((entry) => entry.kind === kind && entry.key === key)
}

/**
 * Brings the window of this kind and key back to the front; null when there is none. Every opener goes
 * through here first, so there is one window per workspace, per bot desktop and per design.
 */
export function focusWindow(kind: WindowKind, key: string): BrowserWindow | null {
  const entry = find(kind, key)
  if (!entry) return null
  if (entry.window.isMinimized()) entry.window.restore()
  entry.window.focus()
  return entry.window
}

export function closeWindow(kind: WindowKind, key: string): boolean {
  const entry = find(kind, key)
  entry?.window.close()
  return Boolean(entry)
}

export function isAppWindow(webContentsId: number): boolean {
  return windows.has(webContentsId)
}

export function windowKind(webContentsId: number): WindowKind | null {
  return windows.get(webContentsId)?.kind ?? null
}

/** `kind:key` of a window, for logs. */
export function windowLabel(webContentsId: number): string {
  const entry = windows.get(webContentsId)
  return entry ? `${entry.kind}:${entry.key}` : `webContents:${webContentsId}`
}

/** Workspace a window of any kind shows. */
export function windowWorkspace(webContentsId: number): string | null {
  return windows.get(webContentsId)?.workspaceId ?? null
}

/** Workspaces with an open window (of these kinds, or of any kind). */
export function workspaceIds(kinds?: readonly WindowKind[]): string[] {
  const entries = [...windows.values()].filter((entry) => !kinds || kinds.includes(entry.kind))
  return [...new Set(entries.map((entry) => entry.workspaceId))]
}

/** Every open window of this kind. */
export function windowsOf(kind: WindowKind): BrowserWindow[] {
  return [...windows.values()].filter((entry) => entry.kind === kind).map((entry) => entry.window)
}

export function windowCount(kind: WindowKind): number {
  return [...windows.values()].filter((entry) => entry.kind === kind).length
}

/** A workspace window switched to another workspace. */
export function setWindowWorkspace(webContentsId: number, workspaceId: string, title: string): void {
  const entry = windows.get(webContentsId)
  if (entry?.kind !== 'workspace') return
  const previous = entry.workspaceId
  entry.workspaceId = workspaceId
  entry.key = workspaceId
  entry.window.setTitle(title)
  if (previous === workspaceId) return
  entry.conversationId = null
  notifyIfReleased(previous)
}

export function setActiveConversation(webContentsId: number, conversationId: string | null): void {
  const entry = windows.get(webContentsId)
  if (entry?.kind === 'workspace') entry.conversationId = conversationId
}

/** Whether a workspace window of the workspace is the focused one, and what it shows. */
export function workspaceFocus(workspaceId: string): { focused: boolean; conversationId: string | null } {
  const entry = [...windows.values()].find(
    (e) => e.kind === 'workspace' && e.workspaceId === workspaceId && e.window.isFocused(),
  )
  return { focused: Boolean(entry), conversationId: entry?.conversationId ?? null }
}

/** Every closed window, or only those of `kind`. */
export function onWindowClosed(listener: (closed: ClosedWindow) => void, kind?: WindowKind): void {
  closedListeners.add({ kind, listener })
}

/**
 * Fires when the last workspace window showing a workspace closes or switches to another workspace.
 * VM and canvas windows are extra views and never keep a workspace open: the daemon then applies the
 * workspace's close behavior even while one of them is still on screen.
 */
export function onWorkspaceReleased(listener: (workspaceId: string) => void): void {
  releasedListeners.add(listener)
}

function notifyIfReleased(workspaceId: string): void {
  if (workspaceIds(['workspace']).includes(workspaceId)) return
  for (const listener of releasedListeners) listener(workspaceId)
}
