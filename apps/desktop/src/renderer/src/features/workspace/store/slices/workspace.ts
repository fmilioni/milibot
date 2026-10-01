import { DEFAULT_APP_SETTINGS } from '@milibot/shared'

import { api } from '@/api/daemon'
import { CHAT_SCREEN } from '@/features/workspace/lib/navigation'

import type { StoreContext } from '../context'
import type { WorkspaceSlice } from '../types'

export function workspaceSlice(ctx: StoreContext): WorkspaceSlice {
  const { get, set, ws } = ctx
  return {
    workspaceId: null,
    workspaces: [],
    appSettings: DEFAULT_APP_SETTINGS,
    runtimeStatus: 'stopped',
    status: null,
    vm: null,
    cliUsage: {},

    async switchWorkspace(workspaceId) {
      if (workspaceId === get().workspaceId) return
      const workspace = get().workspaces.find((w) => w.id === workspaceId)
      if (get().screen.kind !== 'settings') get().navigate(CHAT_SCREEN)
      set({
        workspaceId,
        bots: {},
        conversations: {},
        sections: [],
        threads: {},
        activity: {},
        statusDetail: {},
        pendingReplies: {},
        botConversation: {},
        statusSession: {},
        selectedConversationId: null,
        internalConversationId: null,
        vmBotId: null,
        status: null,
        vm: null,
        cliUsage: {},
      })
      if (workspace) await window.milibot.setWindowWorkspace(workspace.id, workspace.name)
      ctx.followWorkspace(workspaceId)
      await ctx.loadWorkspaceData(workspaceId)
    },

    async createWorkspace({ name, color, closeBehavior, copyFrom }) {
      const workspace = await api().call('createWorkspace', {
        body: { name, color, closeBehavior, setup: true, ...(copyFrom ? { copyFrom } : {}) },
      })
      ctx.upsertWorkspace(workspace)
      get().closeSettings()
      await get().switchWorkspace(workspace.id)
    },

    async updateSetup(step) {
      ctx.upsertWorkspace(
        await api().call('updateWorkspaceSetup', { params: { workspaceId: ws() }, body: { step } }),
      )
    },

    async setupVm(size) {
      ctx.upsertWorkspace(await api().call('setupWorkspaceVm', { params: { workspaceId: ws() }, body: size }))
    },

    openWorkspaceInNewWindow(workspaceId) {
      void window.milibot.openWorkspaceWindow(workspaceId)
    },

    async updateWorkspace(workspaceId, patch) {
      await ctx.withRollback(async () =>
        ctx.upsertWorkspace(await api().call('updateWorkspace', { params: { workspaceId }, body: patch })),
      )
    },

    async deleteWorkspace(workspaceId) {
      await api().call('deleteWorkspace', { params: { workspaceId } })
    },

    async updateAppSettings(patch) {
      ctx.applySettings({ ...get().appSettings, ...patch })
      ctx.applySettings(await api().call('updateAppSettings', { body: patch }))
    },

    async refreshVm() {
      const id = get().workspaceId
      if (id) await ctx.loadVm(id)
    },

    async startVm() {
      set({ vm: await api().call('startVm', { params: { workspaceId: ws() } }) })
    },

    async resetUsageCounter() {
      set({ status: await api().call('resetUsageCounter', { params: { workspaceId: ws() } }) })
    },

    async resumeSpend() {
      await ctx.withRollback(() => api().call('resumeSpend', { params: { workspaceId: ws() } }))
    },
  }
}
