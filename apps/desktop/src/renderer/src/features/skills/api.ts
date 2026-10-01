import { api } from '@/api/daemon'

export const getSkillUsage = (workspaceId: string, skillId: string) =>
  api().call('getSkillUsage', { params: { workspaceId, skillId } })
