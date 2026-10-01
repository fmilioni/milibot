import { useAppStore } from './store'

/** The open workspace's id, for components that only render inside one. */
export function useWorkspaceId(): string {
  const workspaceId = useAppStore((s) => s.workspaceId)
  if (!workspaceId) throw new Error('useWorkspaceId() needs an open workspace')
  return workspaceId
}
