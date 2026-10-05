import {
  DEFAULT_WORKSPACE_PREFERENCES,
  type HostInfo,
  type UpdateWorkspacePreferencesBody,
  type WorkspaceEvent,
  type WorkspacePreferences,
} from '@milibot/shared'
import { useCallback, useEffect } from 'react'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { useAppStore } from '@/features/workspace/store'

interface SettingsState {
  workspaceId: string | null
  preferences: WorkspacePreferences | null
  host: HostInfo | null
  loadPreferences(workspaceId: string): Promise<void>
  /** Optimistic; reverts to the daemon's copy on failure (and rethrows). */
  updatePreferences(workspaceId: string, patch: UpdateWorkspacePreferencesBody): Promise<void>
  /** Cached after the first load; `force` re-reads it (e.g. QEMU installed meanwhile). */
  loadHost(force?: boolean): Promise<void>
  /** A change from anywhere (another window, a bot's tool, an approved card) shows at once. */
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

/** Workspace preferences and host limits shared by the settings sections. */
export const useSettingsStore = create<SettingsState>()((set, get) => {
  const { forWorkspace, commit } = createWorkspaceScope(get, set, () => ({ preferences: null }))
  return {
    workspaceId: null,
    preferences: null,
    host: null,

    async loadPreferences(workspaceId) {
      forWorkspace(workspaceId)
      const preferences = await api().call('getWorkspacePreferences', { params: { workspaceId } })
      commit(workspaceId, { preferences })
    },

    async updatePreferences(workspaceId, patch) {
      const current = get().preferences
      if (current) commit(workspaceId, { preferences: { ...current, ...patch } })
      try {
        const preferences = await api().call('updateWorkspacePreferences', {
          params: { workspaceId },
          body: patch,
        })
        commit(workspaceId, { preferences })
      } catch (err) {
        await get()
          .loadPreferences(workspaceId)
          .catch(() => undefined)
        throw err
      }
    },

    async loadHost(force = false) {
      if (get().host && !force) return
      set({ host: await api().call('getHostInfo', {}) })
    },

    applyEvent(workspaceId, event) {
      if (event.type === 'preferences.updated')
        commit(workspaceId, { preferences: event.payload.preferences })
    },
  }
})

/**
 * The workspace's preferences, (re)loaded when the component mounts; the shared defaults until they
 * arrive (`loaded` false). `set` is optimistic and shows the error toast when the daemon refuses it.
 */
export function useWorkspacePreferences(workspaceId: string): {
  prefs: WorkspacePreferences
  loaded: boolean
  set: (patch: UpdateWorkspacePreferencesBody) => Promise<void>
} {
  const preferences = useSettingsStore((s) => (s.workspaceId === workspaceId ? s.preferences : null))
  const loadPreferences = useSettingsStore((s) => s.loadPreferences)
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)
  useEffect(() => {
    if (workspaceId) void loadPreferences(workspaceId).catch(() => undefined)
  }, [loadPreferences, workspaceId])
  const set = useCallback(
    (patch: UpdateWorkspacePreferencesBody) =>
      updatePreferences(workspaceId, patch).catch((err: unknown) => {
        console.error('[settings] preferences not saved', err)
        useAppStore.getState().showToast('error')
      }),
    [updatePreferences, workspaceId],
  )
  return { prefs: preferences ?? DEFAULT_WORKSPACE_PREFERENCES, loaded: preferences !== null, set }
}
