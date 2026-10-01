import { api } from '@/api/daemon'

export const getDesignFrameHtml = (workspaceId: string, designId: string, frameId: string, theme: string) =>
  api().call('getDesignFrameHtml', { params: { workspaceId, designId, frameId }, query: { theme } })

export const getDesignFrameSource = (workspaceId: string, designId: string, frameId: string) =>
  api().call('getDesignFrameSource', { params: { workspaceId, designId, frameId } })

/** Writes the design (or some of its frames) as a `.mbdesign` at `path`. */
export const exportDesign = (workspaceId: string, designId: string, path: string, frameIds?: string[]) =>
  api().call('exportDesign', {
    params: { workspaceId, designId },
    body: { path, ...(frameIds ? { frameIds } : {}) },
  })
