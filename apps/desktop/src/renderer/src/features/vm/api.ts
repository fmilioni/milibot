import type { VmDiskKind } from '@milibot/shared'

import { api } from '@/api/daemon'

export const getBotDisplay = (workspaceId: string, botId: string) =>
  api().call('getBotDisplay', { params: { workspaceId, botId } })

export const getVmStats = (workspaceId: string) => api().call('getVmStats', { params: { workspaceId } })

export const stopVm = (workspaceId: string) => api().call('stopVm', { params: { workspaceId } })

/** The VM settings' calls; each answers with the VM details as they are now. */
export const vmSettings = {
  details: (workspaceId: string) => api().call('getVmDetails', { params: { workspaceId } }),
  cancelSystemUpdate: (workspaceId: string) =>
    api().call('cancelVmSystemUpdate', { params: { workspaceId } }),
  updateSystem: (workspaceId: string, whenIdle: boolean) =>
    api().call('updateVmSystem', { params: { workspaceId }, body: { whenIdle } }),
  restart: (workspaceId: string, whenIdle: boolean) =>
    api().call('restartVm', { params: { workspaceId }, body: { whenIdle } }),
  updateResources: (workspaceId: string, body: { cpus?: number; memGb?: number }) =>
    api().call('updateVmResources', { params: { workspaceId }, body }),
  growDisk: (workspaceId: string, disk: VmDiskKind, sizeGb: number) =>
    api().call('growVmDisk', { params: { workspaceId }, body: { disk, sizeGb } }),
  createSnapshot: (workspaceId: string, name: string | null) =>
    api().call('createVmSnapshot', { params: { workspaceId }, body: name ? { name } : {} }),
  restoreSnapshot: (workspaceId: string, name: string) =>
    api().call('restoreVmSnapshot', { params: { workspaceId, name } }),
  deleteSnapshot: (workspaceId: string, name: string) =>
    api().call('deleteVmSnapshot', { params: { workspaceId, name } }),
  async reset(workspaceId: string) {
    await api().call('resetVm', { params: { workspaceId } })
    return api().call('getVmDetails', { params: { workspaceId } })
  },
}
