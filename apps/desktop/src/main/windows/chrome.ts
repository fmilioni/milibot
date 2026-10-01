import type { BrowserWindowConstructorOptions } from 'electron'

import type { WindowKind } from './types'

/** Where the traffic lights sit on macOS, aligned with each window's header. */
const TRAFFIC_LIGHTS: Record<WindowKind, { x: number; y: number }> = {
  workspace: { x: 16, y: 14 },
  canvas: { x: 14, y: 19 },
  vm: { x: 14, y: 13 },
}

/** Height of the Windows caption buttons, matching the renderer's title-bar zone. */
const OVERLAY_HEIGHT: Record<WindowKind, number> = { workspace: 40, canvas: 52, vm: 40 }

const APP_BACKGROUND = { light: '#FBFBFA', dark: '#0D0E11' }

const BACKGROUND: Record<WindowKind, { light: string; dark: string }> = {
  workspace: APP_BACKGROUND,
  canvas: { light: '#F4F4F2', dark: '#14161A' },
  vm: APP_BACKGROUND,
}

const OVERLAY_COLORS = {
  light: { color: APP_BACKGROUND.light, symbolColor: '#1A1B1F' },
  dark: { color: APP_BACKGROUND.dark, symbolColor: '#E8E9EC' },
}

/** Painted before the renderer draws, matching each screen's background. */
export function windowBackground(kind: WindowKind, dark: boolean): string {
  return BACKGROUND[kind][dark ? 'dark' : 'light']
}

/**
 * Title bar per platform. macOS: content under the title bar with inset traffic lights (the renderer
 * leaves room for them). Windows: frameless with the native caption buttons as an overlay. Linux: the
 * window manager's own frame, with the window menu hidden until Alt is pressed.
 */
export function windowChrome(
  kind: WindowKind,
  platform: NodeJS.Platform = process.platform,
  dark = false,
): BrowserWindowConstructorOptions {
  if (platform === 'darwin')
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS[kind] }
  if (platform === 'win32')
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { ...OVERLAY_COLORS[dark ? 'dark' : 'light'], height: OVERLAY_HEIGHT[kind] },
    }
  return { autoHideMenuBar: true }
}
