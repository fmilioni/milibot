import {
  type AppEvent,
  type AppSettings,
  byRecentlyOpened,
  type ConversationSummary,
  DEFAULT_APP_SETTINGS,
  type WorkspaceEvent,
  type WorkspaceSummary,
} from '@milibot/shared'

import { api, followWorkspaceEvents } from '@/api/daemon'
import { queryKeys } from '@/api/queries'
import { queryClient } from '@/api/query-client'
import { createWorkspaceScope } from '@/api/workspace-scope'
import i18n, { setLanguage } from '@/i18n'
import { upsertById } from '@/lib/collections'
import { setThemePreference } from '@/lib/theme'

import { createThreads } from './threads'
import type { AppState, ToastKey } from './types'
import { applyWorkspaceEvent, defaultConversation } from './workspace-events'

export type StoreContext = ReturnType<typeof createStoreContext>

function byId<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]))
}

/** What the app store's slices share: the open workspace, its loading and event handling, rollbacks. */
export function createStoreContext(set: (patch: Partial<AppState>) => void, get: () => AppState) {
  const ws = () => {
    const id = get().workspaceId
    if (!id) throw new Error('No workspace selected')
    return id
  }
  const { commit } = createWorkspaceScope(get, set)
  const threads = createThreads(get, set, ws)
  /** False in windows without the chat (the canvas window): no conversation is selected or marked read. */
  const options = { withChat: true }

  const applySettings = (settings: AppSettings) => {
    const merged = { ...DEFAULT_APP_SETTINGS, ...settings }
    setLanguage(merged.language)
    setThemePreference(merged.theme)
    set({ appSettings: merged })
  }

  const upsertWorkspace = (workspace: WorkspaceSummary) => {
    set({ workspaces: upsertById(get().workspaces, workspace) })
    if (workspace.id === get().workspaceId) {
      void window.milibot.setWindowWorkspace(workspace.id, workspace.name)
    }
  }

  const upsertConversations = (conversations: ConversationSummary[]) => {
    if (conversations.length === 0) return
    set({ conversations: { ...get().conversations, ...byId(conversations) } })
  }

  /** Selects a conversation without leaving the current screen, and loads its messages. */
  const pickConversation = (conversationId: string) => {
    if (get().selectedConversationId === conversationId) return
    set({ selectedConversationId: conversationId })
    selected(conversationId)
  }

  /** What selecting a conversation sets off: the VM panel follows it, a hidden one comes back, messages load. */
  const selected = (conversationId: string) => {
    set({ vmBotId: null })
    const conversation = get().conversations[conversationId]
    if (conversation?.sidebar.hidden) void get().setHidden(conversationId, false)
    void threads.loadLatest(conversationId).catch(() => undefined)
  }

  const loadVm = async (workspaceId: string) => {
    try {
      commit(workspaceId, { vm: await api().call('getVm', { params: { workspaceId } }) })
    } catch {
      commit(workspaceId, { vm: null })
    }
  }

  const loadCliUsage = async (workspaceId: string) => {
    try {
      const usage = await api().call('getCliUsage', { params: { workspaceId } })
      commit(workspaceId, { cliUsage: Object.fromEntries(usage.map((u) => [u.providerId, u])) })
    } catch {
      // Runtime restarting: the footer simply shows no quota.
    }
  }

  const loadWorkspaceData = async (workspaceId: string) => {
    const params = { workspaceId }
    const opened = await api().call('openWorkspace', { params })
    upsertWorkspace(opened)
    const [bots, conversations, sections, status] = await Promise.all([
      api().call('listBots', { params }),
      api().call('listConversations', { params }),
      api().call('listSidebarSections', { params }),
      api().call('getWorkspaceStatus', { params }),
    ])
    const botMap = byId(bots)
    const selected = get().selectedConversationId
    const keepSelection =
      !options.withChat || (selected !== null && conversations.some((c) => c.id === selected))
    set({
      runtimeStatus: opened.runtimeStatus,
      pendingReplies: {},
      bots: botMap,
      conversations: byId(conversations),
      sections,
      status,
      threads: keepSelection ? get().threads : {},
      selectedConversationId: keepSelection ? selected : defaultConversation(conversations, botMap),
    })
    void loadVm(workspaceId)
    void loadCliUsage(workspaceId)
    const current = get().selectedConversationId
    if (current) await threads.loadLatest(current)
  }

  /** Runs an optimistic update; on failure reloads the workspace so the UI never drifts. */
  const withRollback = async (
    action: () => Promise<unknown>,
    toast: (err: unknown) => ToastKey = () => 'error',
  ) => {
    try {
      await action()
    } catch (err) {
      console.error('[store] action failed', err)
      get().showToast(toast(err))
      const id = get().workspaceId
      if (id) await loadWorkspaceData(id).catch(() => undefined)
    }
  }

  /** Saves a conversation change and keeps what the daemon returns (rolled back on failure). */
  const syncConversation = (call: () => Promise<ConversationSummary>) =>
    withRollback(async () => upsertConversations([await call()]))

  /** A workspace event: the pure state change, then what it sets off. */
  const receiveWorkspaceEvent = (event: WorkspaceEvent) => {
    const before = get()
    const at = Date.now()
    set(applyWorkspaceEvent(before, event, at))
    const after = get()
    switch (event.type) {
      case 'workspace.updated':
        if (event.payload.workspace.id === after.workspaceId)
          void window.milibot.setWindowWorkspace(event.payload.workspace.id, event.payload.workspace.name)
        break
      case 'runtime.status': {
        const open = after.selectedConversationId
        if (event.payload.status === 'running' && open && after.threads[open]?.error)
          void threads.loadLatest(open).catch(() => undefined)
        break
      }
      case 'conversation.deleted': {
        const next = after.selectedConversationId
        if (next && next !== before.selectedConversationId) selected(next)
        break
      }
      case 'message.created':
        threads.afterMessageCreated(event.payload.message, before.pendingReplies, at)
        break
    }
  }

  const receiveAppEvent = (event: AppEvent) => {
    switch (event.type) {
      case 'workspace.created':
      case 'workspace.updated':
        upsertWorkspace(event.payload.workspace)
        break
      case 'workspace.deleted':
        set({ workspaces: get().workspaces.filter((w) => w.id !== event.payload.workspaceId) })
        if (event.payload.workspaceId === get().workspaceId) void leaveDeletedWorkspace()
        break
      case 'app_settings.updated':
        applySettings(event.payload.settings)
        break
    }
  }

  /** The window's workspace was deleted: show the most recent other one (or a fresh one). */
  const leaveDeletedWorkspace = async () => {
    const next = [...get().workspaces].sort(byRecentlyOpened)[0]
    get().closeSettings()
    if (next) {
      await api()
        .call('openWorkspace', { params: { workspaceId: next.id } })
        .catch(() => undefined)
      await get().switchWorkspace(next.id)
      return
    }
    const created = await api().call('createWorkspace', {
      body: { name: i18n.t('settings.general.defaultWorkspaceName'), color: 'violet', setup: true },
    })
    upsertWorkspace(created)
    await get().switchWorkspace(created.id)
  }

  const followWorkspace = (workspaceId: string) => {
    let connectedOnce = false
    followWorkspaceEvents(workspaceId, {
      isCurrent: (id) => id === get().workspaceId,
      apply: receiveWorkspaceEvent,
      onOpen: () => {
        set({ connectionState: 'online' })
        // After a reconnect, resync whatever happened while the stream was down.
        if (connectedOnce) {
          void loadWorkspaceData(workspaceId).catch(() => undefined)
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) })
        }
        connectedOnce = true
      },
      onClose: () => set({ connectionState: 'offline' }),
    })
  }

  return {
    get,
    set,
    ws,
    commit,
    threads,
    options,
    applySettings,
    upsertWorkspace,
    upsertConversations,
    pickConversation,
    loadVm,
    loadWorkspaceData,
    withRollback,
    syncConversation,
    receiveWorkspaceEvent,
    receiveAppEvent,
    followWorkspace,
  }
}
