import type { BrowserWindow } from 'electron'
import type { z } from 'zod'

import type { VmWindowOptions } from '../../bridge/contract'
import { createAppWindow, workAreaNear } from './create'
import { closeWindow, focusWindow, onWindowClosed } from './registry'
import { VM_DESKTOP, VM_TOOLBAR_HEIGHT, vmWindowSize } from './vm-size'

export interface VmWindowTarget {
  workspaceId: string
  botId: string
}

const keyOf = (workspaceId: string, botId: string) => `${workspaceId}:${botId}`

export function onVmWindowClosed(listener: (target: VmWindowTarget) => void): void {
  onWindowClosed(({ workspaceId, key }) => {
    listener({ workspaceId, botId: key.slice(workspaceId.length + 1) })
  }, 'vm')
}

export function openVmWindow(
  options: z.output<typeof VmWindowOptions>,
  near: BrowserWindow | null,
): BrowserWindow {
  const key = keyOf(options.workspaceId, options.botId)
  const existing = focusWindow('vm', key)
  if (existing) {
    existing.setTitle(options.title)
    return existing
  }

  const window = createAppWindow({
    kind: 'vm',
    key,
    workspaceId: options.workspaceId,
    title: options.title,
    bounds: {
      ...vmWindowSize(workAreaNear(near)),
      useContentSize: true,
      minWidth: 480,
      minHeight: 300 + VM_TOOLBAR_HEIGHT,
    },
    route: {
      path: '/vm',
      query: { workspace: options.workspaceId, bot: options.botId, mode: options.mode },
    },
  })
  window.setAspectRatio(VM_DESKTOP.width / VM_DESKTOP.height, { width: 0, height: VM_TOOLBAR_HEIGHT })
  return window
}

export function closeVmWindow(workspaceId: string, botId: string): boolean {
  return closeWindow('vm', keyOf(workspaceId, botId))
}
