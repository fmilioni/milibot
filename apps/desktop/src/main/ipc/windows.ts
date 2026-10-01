import { BrowserWindow } from 'electron'

import { logRendererError } from '../services/logging/renderer-log'
import { openCanvasWindow } from '../windows/canvas'
import { setActiveConversation, setWindowWorkspace, windowWorkspace, workspaceIds } from '../windows/registry'
import { closeVmWindow, openVmWindow } from '../windows/vm'
import { openWorkspace } from '../windows/workspace'
import type { InvokeHandlers, SendHandlers } from './handle'
import type { IpcDeps } from './register'

export function windowInvokes({ daemon, vncBridge }: IpcDeps) {
  return {
    getContext: async (event) => {
      const workspaceId = windowWorkspace(event.sender.id)
      if (!workspaceId) throw new Error('Window is not bound to a workspace')
      return { workspaceId, daemon: await daemon.connection() }
    },

    openWorkspaceWindow: async (_event, [workspaceId]) => openWorkspace(await daemon.client(), workspaceId),

    setWindowWorkspace: (event, [workspaceId, title]) =>
      setWindowWorkspace(event.sender.id, workspaceId, title),

    listOpenWorkspaces: () => workspaceIds(['workspace']),

    openVnc: async (event, [target]) => {
      if (windowWorkspace(event.sender.id) !== target.workspaceId)
        throw new Error('Workspace of another window')
      return { url: await vncBridge.issue(event.sender.id, target) }
    },

    openVmWindow: (event, [options]) => {
      openVmWindow(options, BrowserWindow.fromWebContents(event.sender))
    },

    closeVmWindow: (event, [workspaceId, botId]) => {
      if (closeVmWindow(workspaceId, botId)) BrowserWindow.fromWebContents(event.sender)?.focus()
    },

    openCanvasWindow: (event, [options]) => {
      openCanvasWindow(options, BrowserWindow.fromWebContents(event.sender))
    },
  } satisfies Partial<InvokeHandlers>
}

export const windowSends = {
  reportRendererError: (event, [report]) => logRendererError(event.sender.id, report),

  setActiveConversation: (event, [conversationId]) => setActiveConversation(event.sender.id, conversationId),

  setTitleBarOverlay: (event, [colors]) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && process.platform === 'win32') window.setTitleBarOverlay(colors)
  },
} satisfies SendHandlers
