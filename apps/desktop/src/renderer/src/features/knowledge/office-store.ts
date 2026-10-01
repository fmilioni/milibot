import type { OfficeStatus, WorkspaceEvent } from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { useSettingsStore } from '@/features/settings/store'

interface OfficeState {
  workspaceId: string | null
  /** LibreOffice in the VM ("Old Office files", knowledge.legacyOffice); null until loaded. */
  status: OfficeStatus | null
  load(workspaceId: string): Promise<void>
  retry(workspaceId: string): Promise<void>
}

export const useOfficeStore = create<OfficeState>()((set, get) => {
  const { forWorkspace, commit } = createWorkspaceScope(get, set, () => ({ status: null }))
  return {
    workspaceId: null,
    status: null,

    async load(workspaceId) {
      forWorkspace(workspaceId)
      commit(workspaceId, { status: await api().call('getOfficeStatus', { params: { workspaceId } }) })
    },

    async retry(workspaceId) {
      commit(workspaceId, { status: await api().call('retryOffice', { params: { workspaceId } }) })
    },
  }
})

/** LibreOffice's status follows `office.status` (registered at boot). */
export function applyOfficeEvent(workspaceId: string, event: WorkspaceEvent): void {
  if (event.type !== 'office.status' || useOfficeStore.getState().workspaceId !== workspaceId) return
  const { status } = event.payload
  useOfficeStore.setState({ status })
  // The preference may change elsewhere (another window, the API); the status carries it.
  const { workspaceId: prefsWorkspace, preferences } = useSettingsStore.getState()
  if (prefsWorkspace === workspaceId && preferences && preferences.legacyOffice !== status.enabled)
    useSettingsStore.setState({ preferences: { ...preferences, legacyOffice: status.enabled } })
}
