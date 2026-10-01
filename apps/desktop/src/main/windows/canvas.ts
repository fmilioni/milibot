import type { BrowserWindow } from 'electron'

import type { CanvasWindowOptions } from '../../bridge/contract'
import { createAppWindow, workAreaNear } from './create'
import { focusWindow } from './registry'

/** "Open in window": only a design's canvas. */
export function openCanvasWindow(options: CanvasWindowOptions, near: BrowserWindow | null): BrowserWindow {
  const key = `${options.workspaceId}:${options.designId}`
  const existing = focusWindow('canvas', key)
  if (existing) return existing

  const area = workAreaNear(near)
  return createAppWindow({
    kind: 'canvas',
    key,
    workspaceId: options.workspaceId,
    title: options.title,
    bounds: {
      width: Math.min(1400, area.width - 80),
      height: Math.min(900, area.height - 80),
      minWidth: 560,
      minHeight: 400,
    },
    route: { path: '/canvas', query: { workspace: options.workspaceId, design: options.designId } },
  })
}
