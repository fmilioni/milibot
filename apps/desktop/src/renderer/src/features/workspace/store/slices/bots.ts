import type { Bot } from '@milibot/shared'

import { api } from '@/api/daemon'
import { screenKey } from '@/features/vm/lib/screen-control'

import type { StoreContext } from '../context'
import { takenOverHere } from '../taken-over'
import type { BotsSlice } from '../types'

export function botsSlice(ctx: StoreContext): BotsSlice {
  const { get, set, ws } = ctx
  return {
    bots: {},
    statusDetail: {},
    pendingReplies: {},
    botConversation: {},
    statusSession: {},
    activity: {},

    generateBotPrompt(input) {
      return api().call('generateBotPrompt', { params: { workspaceId: ws() }, body: input })
    },

    async createBot(input) {
      const { bot, conversation } = await api().call('createBot', {
        params: { workspaceId: ws() },
        body: {
          name: input.name,
          label: input.label,
          systemPrompt: input.systemPrompt,
          avatar: input.avatar,
          model: input.model ?? null,
        },
      })
      set({ bots: { ...get().bots, [bot.id]: bot } })
      ctx.upsertConversations([conversation])
      if (input.sectionId)
        await get().moveConversation(conversation.id, { pinned: false, sectionId: input.sectionId })
      get().selectConversation(conversation.id)
    },

    async updateBot(botId, patch) {
      const bot = get().bots[botId]
      if (bot) {
        const optimistic: Bot = {
          ...bot,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
          ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
        }
        set({ bots: { ...get().bots, [botId]: optimistic } })
      }
      await ctx.withRollback(async () => {
        const updated = await api().call('updateBot', { params: { workspaceId: ws(), botId }, body: patch })
        set({ bots: { ...get().bots, [botId]: updated } })
      })
    },

    async controlBot(botId, action, options) {
      const workspaceId = ws()
      const result = await api().call('controlBot', {
        params: { workspaceId, botId },
        body: { action, ...options },
      })
      const key = screenKey({ workspaceId, botId })
      if (result.control !== 'user') takenOverHere.delete(key)
      else if (action === 'takeover') takenOverHere.add(key)
    },

    async loadActivity(botId) {
      try {
        const actions = await api().call('getBotActivity', {
          params: { workspaceId: ws(), botId },
          query: { limit: 100 },
        })
        set({ activity: { ...get().activity, [botId]: actions } })
      } catch {
        set({ activity: { ...get().activity, [botId]: get().activity[botId] ?? [] } })
      }
    },
  }
}
