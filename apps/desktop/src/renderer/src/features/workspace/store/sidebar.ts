import { applySidebarMove } from '@milibot/shared'

import { api } from '@/api/daemon'
import { sidebarOrderItems } from '@/features/sidebar/sidebar-groups'
import { apiErrorReason } from '@/lib/errors'

import type { StoreContext } from './context'
import type { ConversationsSlice } from './types'

type SidebarActions = Pick<
  ConversationsSlice,
  | 'moveConversation'
  | 'setPinned'
  | 'setHidden'
  | 'markUnread'
  | 'renameConversation'
  | 'deleteConversation'
  | 'createSection'
  | 'updateSection'
  | 'deleteSection'
  | 'reorderSections'
>

/** The app store's sidebar actions: optimistic, rolled back by reloading the workspace on failure. */
export function sidebarActions({
  get,
  set,
  ws,
  upsertConversations,
  withRollback,
  syncConversation,
}: StoreContext): SidebarActions {
  return {
    async moveConversation(conversationId, to, index) {
      const changes = applySidebarMove(sidebarOrderItems(get().conversations), {
        id: conversationId,
        to,
        index,
      })
      if (changes.size === 0) return
      const conversations = { ...get().conversations }
      for (const [id, patch] of changes) {
        const current = conversations[id]
        if (!current) continue
        conversations[id] = {
          ...current,
          sidebar: {
            ...current.sidebar,
            pinned: patch.pinned,
            sectionId: patch.sectionId,
            order: patch.order,
          },
        }
      }
      set({ conversations })
      const target = changes.get(conversationId)
      await withRollback(async () =>
        upsertConversations(
          await api().call('moveSidebarItem', {
            params: { workspaceId: ws(), conversationId },
            body: { pinned: to.pinned, sectionId: to.sectionId, index: target?.order },
          }),
        ),
      )
    },

    async setPinned(conversationId, pinned) {
      const conversation = get().conversations[conversationId]
      if (!conversation) return
      await get().moveConversation(conversationId, { pinned, sectionId: conversation.sidebar.sectionId })
    },

    async setHidden(conversationId, hidden) {
      const conversation = get().conversations[conversationId]
      if (conversation) {
        upsertConversations([{ ...conversation, sidebar: { ...conversation.sidebar, hidden } }])
      }
      await syncConversation(() =>
        api().call('updateSidebarItem', { params: { workspaceId: ws(), conversationId }, body: { hidden } }),
      )
    },

    async markUnread(conversationId) {
      if (get().selectedConversationId === conversationId) set({ selectedConversationId: null })
      await syncConversation(() =>
        api().call('updateSidebarItem', {
          params: { workspaceId: ws(), conversationId },
          body: { unread: true },
        }),
      )
    },

    async renameConversation(conversationId, name) {
      const conversation = get().conversations[conversationId]
      const trimmed = name.trim()
      if (!conversation || !trimmed) return
      if (conversation.type === 'direct') {
        const botId = conversation.memberBotIds[0]
        if (botId) await get().updateBot(botId, { name: trimmed })
        return
      }
      await syncConversation(() =>
        api().call('updateConversation', {
          params: { workspaceId: ws(), conversationId },
          body: { title: trimmed },
        }),
      )
    },

    async deleteConversation(conversationId) {
      const conversation = get().conversations[conversationId]
      if (!conversation) return
      await withRollback(
        async () => {
          if (conversation.type === 'direct') {
            const botId = conversation.memberBotIds[0]
            if (botId) await api().call('deleteBot', { params: { workspaceId: ws(), botId } })
          } else {
            await api().call('deleteConversation', { params: { workspaceId: ws(), conversationId } })
          }
        },
        (err) => (apiErrorReason(err) === 'last_bot' ? 'lastBot' : 'error'),
      )
    },

    async createSection(name) {
      const section = await api().call('createSidebarSection', {
        params: { workspaceId: ws() },
        body: { name },
      })
      if (!get().sections.some((s) => s.id === section.id)) set({ sections: [...get().sections, section] })
      return section
    },

    async updateSection(sectionId, patch) {
      set({ sections: get().sections.map((s) => (s.id === sectionId ? { ...s, ...patch } : s)) })
      await withRollback(() =>
        api().call('updateSidebarSection', { params: { workspaceId: ws(), sectionId }, body: patch }),
      )
    },

    async deleteSection(sectionId) {
      set({ sections: get().sections.filter((s) => s.id !== sectionId) })
      await withRollback(() =>
        api().call('deleteSidebarSection', { params: { workspaceId: ws(), sectionId } }),
      )
    },

    async reorderSections(sectionIds) {
      const order = new Map(sectionIds.map((id, i) => [id, i]))
      set({
        sections: [...get().sections]
          .map((s) => ({ ...s, order: order.get(s.id) ?? s.order }))
          .sort((a, b) => a.order - b.order),
      })
      await withRollback(async () =>
        set({
          sections: await api().call('reorderSidebarSections', {
            params: { workspaceId: ws() },
            body: { sectionIds },
          }),
        }),
      )
    },
  }
}
