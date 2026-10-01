import type { EndpointBody } from '@milibot/shared'

import { api } from '@/api/daemon'

export const listWorkspaceMemories = (workspaceId: string) =>
  api().call('listWorkspaceMemories', { params: { workspaceId } })

export const createWorkspaceMemory = (workspaceId: string, body: EndpointBody<'createWorkspaceMemory'>) =>
  api().call('createWorkspaceMemory', { params: { workspaceId }, body })

export const updateWorkspaceMemory = (
  workspaceId: string,
  memoryId: string,
  body: EndpointBody<'updateWorkspaceMemory'>,
) => api().call('updateWorkspaceMemory', { params: { workspaceId, memoryId }, body })

export const deleteWorkspaceMemory = (workspaceId: string, memoryId: string) =>
  api().call('deleteWorkspaceMemory', { params: { workspaceId, memoryId } })
