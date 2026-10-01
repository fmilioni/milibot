import { join } from 'node:path'

import { BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme, screen } from 'electron'

import { WINDOW_KIND_ARG } from '../../bridge/channels'
import { logWindowEvent } from '../services/logging/renderer-log'
import { windowBackground, windowChrome } from './chrome'
import { registerWindow } from './registry'
import { rendererLocation } from './trust'
import type { WindowKind } from './types'

export interface AppWindowOptions {
  kind: WindowKind
  key: string
  workspaceId: string
  title: string
  bounds: Pick<
    BrowserWindowConstructorOptions,
    'width' | 'height' | 'minWidth' | 'minHeight' | 'useContentSize'
  >
  /** Renderer hash route (`/vm`, `/canvas`) and its query; none: the workspace screen. */
  route?: { path: string; query: Record<string, string> }
}

/** Every app window: sandboxed preload, shown once painted (navigation rules in `hardening.ts`). */
export function createAppWindow(options: AppWindowOptions): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors
  const window = new BrowserWindow({
    ...options.bounds,
    title: options.title,
    show: false,
    ...windowChrome(options.kind, process.platform, dark),
    backgroundColor: windowBackground(options.kind, dark),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`${WINDOW_KIND_ARG}${options.kind}`],
    },
  })
  registerWindow({ kind: options.kind, window, workspaceId: options.workspaceId, key: options.key })

  window.on('page-title-updated', (event) => event.preventDefault())
  watchRenderer(window)
  window.once('ready-to-show', () => window.show())

  const hash = options.route
    ? `${options.route.path}?${new URLSearchParams(options.route.query).toString()}`
    : null
  const { devUrl, indexFile } = rendererLocation()
  if (devUrl) void window.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
  else void window.loadFile(indexFile, hash ? { hash } : undefined)
  return window
}

/** A page process that dies is logged and reloaded, unless it already died moments ago (a crash loop). */
const RELOAD_GUARD_MS = 30_000

function watchRenderer(window: BrowserWindow): void {
  const contents = window.webContents
  let lastGone = 0
  contents.on('render-process-gone', (_event, details) => {
    logWindowEvent(contents.id, `page process gone: ${details.reason} (exit code ${details.exitCode})`)
    if (details.reason === 'clean-exit' || window.isDestroyed()) return
    const now = Date.now()
    const looping = now - lastGone < RELOAD_GUARD_MS
    lastGone = now
    if (!looping) contents.reload()
  })
  window.on('unresponsive', () => logWindowEvent(contents.id, 'page unresponsive'))
  window.on('responsive', () => logWindowEvent(contents.id, 'page responsive again'))
}

/** Work area of the display showing `near` (the primary display without one). */
export function workAreaNear(near: BrowserWindow | null): Electron.Rectangle {
  return (near ? screen.getDisplayMatching(near.getBounds()) : screen.getPrimaryDisplay()).workArea
}
