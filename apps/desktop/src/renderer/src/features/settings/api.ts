import type { EndpointBody } from '@milibot/shared'

import { api } from '@/api/daemon'

const DAY = 86_400_000

/** Spend of the last 14 days and the last 30 days by bot and by model (Settings › Costs). */
export async function loadCosts(workspaceId: string) {
  const from = Date.now() - 30 * DAY
  const params = { workspaceId }
  const [overview, byBot, byModel] = await Promise.all([
    api().call('getCostOverview', { params, query: { days: 14 } }),
    api().call('getCostSummary', { params, query: { from, groupBy: 'bot' } }),
    api().call('getCostSummary', { params, query: { from, groupBy: 'model' } }),
  ])
  return { overview, byBot, byModel }
}

export const getDebugStorage = (workspaceId: string) =>
  api().call('getDebugStorage', { params: { workspaceId } })
export const purgeDebugData = (workspaceId: string) =>
  api().call('purgeDebugData', { params: { workspaceId } })
export const getSpendStatus = (workspaceId: string) =>
  api().call('getSpendStatus', { params: { workspaceId } })
export const resumeSpend = (workspaceId: string) => api().call('resumeSpend', { params: { workspaceId } })

export const getAttachmentSettings = (workspaceId: string) =>
  api().call('getAttachmentSettings', { params: { workspaceId } })
export const updateAttachmentSettings = (workspaceId: string, maxFileMb: number) =>
  api().call('updateAttachmentSettings', { params: { workspaceId }, body: { maxFileMb } })

export const getGithub = (workspaceId: string) => api().call('getGithub', { params: { workspaceId } })
export const setGithubToken = (workspaceId: string, token: string) =>
  api().call('setGithubToken', { params: { workspaceId }, body: { token } })
export const syncGithub = (workspaceId: string) => api().call('syncGithub', { params: { workspaceId } })
export const deleteGithubToken = (workspaceId: string) =>
  api().call('deleteGithubToken', { params: { workspaceId } })

export const getWebSearch = (workspaceId: string) => api().call('getWebSearch', { params: { workspaceId } })
export const setWebSearchKey = (workspaceId: string, body: EndpointBody<'setWebSearchKey'>) =>
  api().call('setWebSearchKey', { params: { workspaceId }, body })
export const deleteWebSearchKey = (workspaceId: string) =>
  api().call('deleteWebSearchKey', { params: { workspaceId } })

export const listEnvSecrets = (workspaceId: string) =>
  api().call('listEnvSecrets', { params: { workspaceId } })
export const createEnvSecret = (workspaceId: string, body: EndpointBody<'createEnvSecret'>) =>
  api().call('createEnvSecret', { params: { workspaceId }, body })
export const updateEnvSecret = (
  workspaceId: string,
  secretId: string,
  body: EndpointBody<'updateEnvSecret'>,
) => api().call('updateEnvSecret', { params: { workspaceId, secretId }, body })
export const deleteEnvSecret = (workspaceId: string, secretId: string) =>
  api().call('deleteEnvSecret', { params: { workspaceId, secretId } })

export const getSshKey = (workspaceId: string) => api().call('getSshKey', { params: { workspaceId } })

export const getBackupJob = (workspaceId: string) => api().call('getBackupJob', { params: { workspaceId } })
export const getBackupRestore = (workspaceId: string) =>
  api().call('getBackupRestore', { params: { workspaceId } })
export const startBackupJob = (workspaceId: string, body: EndpointBody<'startBackupJob'>) =>
  api().call('startBackupJob', { params: { workspaceId }, body })
export const cancelBackupJob = (workspaceId: string) =>
  api().call('cancelBackupJob', { params: { workspaceId } })
export const estimateBackup = (workspaceId: string, excludes: string[]) =>
  api().call('estimateBackup', { params: { workspaceId }, body: { excludes } })
export const retryBackupRestore = (workspaceId: string, path?: string) =>
  api().call('retryBackupRestore', { params: { workspaceId }, body: path ? { path } : {} })
export const skipBackupRestore = (workspaceId: string) =>
  api().call('skipBackupRestore', { params: { workspaceId } })
export const inspectBackup = (path: string) => api().call('inspectBackup', { body: { path } })
export const importWorkspace = (body: EndpointBody<'importWorkspace'>) =>
  api().call('importWorkspace', { body })

export const getVmDetails = (workspaceId: string) => api().call('getVmDetails', { params: { workspaceId } })

export const listWorkspaceOverviews = () => api().call('listWorkspaceOverviews', {})
