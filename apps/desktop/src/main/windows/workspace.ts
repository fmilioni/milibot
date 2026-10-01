import type { ApiClient } from '@milibot/shared'
import { app, type BrowserWindow } from 'electron'

import { emit } from '../ipc/handle'
import { createAppWindow } from './create'
import { focusWindow } from './registry'

export function openWorkspaceWindow(workspaceId: string, title: string): BrowserWindow {
  return (
    focusWindow('workspace', workspaceId) ??
    createAppWindow({
      kind: 'workspace',
      key: workspaceId,
      workspaceId,
      title,
      bounds: { width: 1440, height: 900, minWidth: 960, minHeight: 600 },
    })
  )
}

async function findWorkspace(client: ApiClient, workspaceId: string) {
  return (await client.call('listWorkspaces', {})).find((w) => w.id === workspaceId)
}

export async function openWorkspace(client: ApiClient, workspaceId: string): Promise<void> {
  const workspace = await findWorkspace(client, workspaceId)
  if (!workspace) throw new Error(`Unknown workspace ${workspaceId}`)
  openWorkspaceWindow(workspace.id, workspace.name)
}

/** A clicked notification: the workspace's window comes to the front on that conversation. */
export async function showConversation(
  client: ApiClient,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  const workspace = await findWorkspace(client, workspaceId)
  if (!workspace) return
  app.focus({ steal: true })
  const window = openWorkspaceWindow(workspace.id, workspace.name)
  const send = () => emit(window.webContents, 'showConversation', workspaceId, conversationId)
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send)
  else send()
}
