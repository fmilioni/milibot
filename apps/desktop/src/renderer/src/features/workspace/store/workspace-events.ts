import { type Bot, type ConversationSummary, firstBot, type WorkspaceEvent } from '@milibot/shared'

import { nextStatusDetail } from '@/features/bots/lib/bot-status'
import { internalWakeTarget } from '@/features/chat/lib/working'
import {
  appendToThread,
  markPendingReplies,
  noteBotConversation,
  removeMessage,
  updateMessage,
} from '@/features/workspace/lib/threads'
import { upsertById } from '@/lib/collections'

import type { AppState } from './types'

const ACTIVITY_LIMIT = 200

export type WorkspaceEventState = Pick<
  AppState,
  | 'workspaces'
  | 'runtimeStatus'
  | 'status'
  | 'vm'
  | 'cliUsage'
  | 'bots'
  | 'statusDetail'
  | 'pendingReplies'
  | 'botConversation'
  | 'statusSession'
  | 'activity'
  | 'conversations'
  | 'sections'
  | 'threads'
  | 'selectedConversationId'
>

/** The conversation a workspace opens on: the first bot's DM, else any DM or group. */
export function defaultConversation(
  conversations: ConversationSummary[],
  bots: Record<string, Bot>,
): string | null {
  const first = firstBot(Object.values(bots))
  const firstDm = conversations.find((c) => c.type === 'direct' && first && c.memberBotIds.includes(first.id))
  return firstDm?.id ?? conversations.find((c) => c.type === 'direct' || c.type === 'group')?.id ?? null
}

/**
 * The app store's state after a workspace event (only the changed fields). Pure: what the event sets off
 * (loading a thread, marking read, expiring optimistic replies) is the store's job.
 */
export function applyWorkspaceEvent(
  state: WorkspaceEventState,
  event: WorkspaceEvent,
  now: number = Date.now(),
): Partial<WorkspaceEventState> {
  switch (event.type) {
    case 'workspace.updated':
      return { workspaces: upsertById(state.workspaces, event.payload.workspace) }
    case 'runtime.status':
      return { runtimeStatus: event.payload.status }
    case 'workspace.status':
      return { status: event.payload.status }
    case 'vm.status':
      return { vm: event.payload.vm }
    case 'provider.usage':
      return { cliUsage: { ...state.cliUsage, [event.payload.usage.providerId]: event.payload.usage } }
    case 'bot.created':
    case 'bot.updated':
      return { bots: { ...state.bots, [event.payload.bot.id]: event.payload.bot } }
    case 'bot.deleted': {
      const { [event.payload.botId]: _gone, ...bots } = state.bots
      return { bots }
    }
    case 'bot.status':
      return botStatus(state, event.payload)
    case 'bot.activity': {
      const { botId, action } = event.payload
      const current = state.activity[botId]
      if (!current) return {}
      const without = current.filter((a) => a.id !== action.id)
      return { activity: { ...state.activity, [botId]: [...without, action].slice(-ACTIVITY_LIMIT) } }
    }
    case 'conversation.created':
    case 'conversation.updated': {
      const { conversation } = event.payload
      return { conversations: { ...state.conversations, [conversation.id]: conversation } }
    }
    case 'conversation.deleted': {
      const { [event.payload.conversationId]: _gone, ...conversations } = state.conversations
      if (state.selectedConversationId !== event.payload.conversationId) return { conversations }
      return {
        conversations,
        selectedConversationId: defaultConversation(Object.values(conversations), state.bots),
      }
    }
    case 'sidebar.sections':
      return { sections: event.payload.sections }
    case 'message.created': {
      const { message } = event.payload
      const patch: Partial<WorkspaceEventState> = {}
      const botConversation = noteBotConversation(state.botConversation, message)
      if (botConversation) patch.botConversation = botConversation
      const woken = internalWakeTarget(state.conversations[message.conversationId], message, state.bots)
      const pending = woken
        ? markPendingReplies(
            { ...state, botConversation: botConversation ?? state.botConversation },
            message.conversationId,
            [woken],
            now,
          )
        : null
      if (pending) Object.assign(patch, pending)
      const threads = appendToThread(state.threads, message)
      if (threads) patch.threads = threads
      return patch
    }
    case 'message.updated': {
      const { message } = event.payload
      const botConversation = noteBotConversation(state.botConversation, message)
      return {
        ...(botConversation ? { botConversation } : {}),
        ...updateMessage(state, message.conversationId, message.id, () => message),
      }
    }
    case 'message.deleted': {
      const threads = removeMessage(state.threads, event.payload.conversationId, event.payload.messageId)
      return threads ? { threads } : {}
    }
    case 'message.delta': {
      const { conversationId, messageId, delta } = event.payload
      return updateMessage(state, conversationId, messageId, (m) => ({ ...m, content: m.content + delta }))
    }
    default:
      return {}
  }
}

function botStatus(
  state: WorkspaceEventState,
  payload: Extract<WorkspaceEvent, { type: 'bot.status' }>['payload'],
): Partial<WorkspaceEventState> {
  const { botId, conversationId, sessionId, status } = payload
  const patch: Partial<WorkspaceEventState> = {
    statusDetail: { ...state.statusDetail, [botId]: nextStatusDetail(state.statusDetail[botId], payload) },
    statusSession: { ...state.statusSession, [botId]: sessionId },
  }
  if (conversationId) patch.botConversation = { ...state.botConversation, [botId]: conversationId }
  const pending = state.pendingReplies[botId]
  // A status from work elsewhere does not mean the bot took up the message it was asked here.
  if (pending && (!conversationId || conversationId === pending.conversationId)) {
    const { [botId]: _taken, ...pendingReplies } = state.pendingReplies
    patch.pendingReplies = pendingReplies
  }
  const bot = state.bots[botId]
  if (bot) patch.bots = { ...state.bots, [botId]: { ...bot, status } }
  return patch
}
