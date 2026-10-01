import { api } from '@/api/daemon'
import { CHAT_SCREEN } from '@/features/workspace/lib/navigation'

import type { StoreContext } from '../context'
import { sidebarActions } from '../sidebar'
import type { ConversationsSlice } from '../types'

export function conversationsSlice(ctx: StoreContext): ConversationsSlice {
  const { get, ws, threads } = ctx
  return {
    conversations: {},
    sections: [],
    threads: {},
    selectedConversationId: null,

    selectConversation(conversationId) {
      if (get().screen.kind !== 'chat') get().navigate(CHAT_SCREEN)
      ctx.pickConversation(conversationId)
    },

    async ensureConversation(conversationId) {
      const known = get().conversations[conversationId]
      if (known) return known
      const conversation = await api().call('getConversation', {
        params: { workspaceId: ws(), conversationId },
      })
      ctx.upsertConversations([conversation])
      return conversation
    },

    async openConversation(conversationId) {
      await get().ensureConversation(conversationId)
      get().selectConversation(conversationId)
    },

    reloadConversation(conversationId) {
      void threads.loadLatest(conversationId).catch(() => undefined)
    },

    loadOlderMessages: (conversationId) => threads.loadOlder(conversationId),

    sendMessage: (conversationId, content, attachmentIds) =>
      threads.send(conversationId, content, attachmentIds),

    ...sidebarActions(ctx),

    async createGroup(botIds, title) {
      const conversation = await api().call('createConversation', {
        params: { workspaceId: ws() },
        body: { type: 'group', botIds, title },
      })
      ctx.upsertConversations([conversation])
      get().selectConversation(conversation.id)
    },

    async updateGroupSettings(conversationId, patch) {
      const conversation = get().conversations[conversationId]
      if (conversation)
        ctx.upsertConversations([{ ...conversation, settings: { ...conversation.settings, ...patch } }])
      await ctx.syncConversation(() =>
        api().call('updateGroupSettings', { params: { workspaceId: ws(), conversationId }, body: patch }),
      )
    },

    async addGroupMember(conversationId, botId) {
      await ctx.syncConversation(() =>
        api().call('addGroupMember', { params: { workspaceId: ws(), conversationId }, body: { botId } }),
      )
    },

    async removeGroupMember(conversationId, botId) {
      await ctx.syncConversation(() =>
        api().call('removeGroupMember', { params: { workspaceId: ws(), conversationId, botId } }),
      )
    },

    async resolveConfirmation(confirmationId, approved) {
      threads.replaceMessage(
        await api().call('resolveConfirmation', {
          params: { workspaceId: ws(), confirmationId },
          body: { approved },
        }),
      )
    },

    async answerSecretRequest(requestId, body) {
      threads.replaceMessage(
        await api().call('answerSecretRequest', { params: { workspaceId: ws(), requestId }, body }),
      )
    },

    async answerQuestion(requestId, answers) {
      threads.replaceMessage(
        await api().call('answerQuestion', { params: { workspaceId: ws(), requestId }, body: { answers } }),
      )
    },

    async declineUserRequest(requestId) {
      threads.replaceMessage(
        await api().call('declineUserRequest', { params: { workspaceId: ws(), requestId } }),
      )
    },
  }
}
