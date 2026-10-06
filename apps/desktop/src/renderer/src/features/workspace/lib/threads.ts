import type { Bot, ConversationSummary, Message } from '@milibot/shared'

export interface MessageThread {
  items: Message[]
  hasMore: boolean
  loading: boolean
  /** Unread count captured when the conversation was opened (drives the unread divider). */
  unreadAtOpen: number
  /** A page of messages arrived at least once (until then `hasMore` means nothing). */
  loaded: boolean
  /** The last load failed (daemon or runtime unreachable); retried while the conversation is open. */
  error: boolean
}

export interface PendingReply {
  conversationId: string
  at: number
}

interface ThreadsState {
  threads: Record<string, MessageThread>
  conversations: Record<string, ConversationSummary>
}

interface PendingState {
  pendingReplies: Record<string, PendingReply | undefined>
  botConversation: Record<string, string | undefined>
  bots: Record<string, Bot>
}

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const map = new Map(existing.map((m) => [m.id, m]))
  for (const message of incoming) map.set(message.id, message)
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A message changed in its loaded thread and in its conversation's preview (empty when neither has it). */
export function updateMessage(
  state: ThreadsState,
  conversationId: string,
  messageId: string,
  update: (m: Message) => Message,
): Partial<ThreadsState> {
  const patch: Partial<ThreadsState> = {}
  const thread = state.threads[conversationId]
  const index = thread ? thread.items.findIndex((m) => m.id === messageId) : -1
  if (thread && index >= 0) {
    const items = [...thread.items]
    items[index] = update(items[index] as Message)
    patch.threads = { ...state.threads, [conversationId]: { ...thread, items } }
  }
  const conversation = state.conversations[conversationId]
  if (conversation?.lastMessage?.id === messageId) {
    patch.conversations = {
      ...state.conversations,
      [conversationId]: { ...conversation, lastMessage: update(conversation.lastMessage) },
    }
  }
  return patch
}

export function removeMessage(
  threads: Record<string, MessageThread>,
  conversationId: string,
  messageId: string,
): Record<string, MessageThread> | null {
  const thread = threads[conversationId]
  if (!thread) return null
  return {
    ...threads,
    [conversationId]: { ...thread, items: thread.items.filter((m) => m.id !== messageId) },
  }
}

/** A message added to its conversation's loaded thread (null when the thread isn't loaded). */
export function appendToThread(
  threads: Record<string, MessageThread>,
  message: Message,
): Record<string, MessageThread> | null {
  const thread = threads[message.conversationId]
  if (!thread) return null
  return {
    ...threads,
    [message.conversationId]: { ...thread, items: mergeMessages(thread.items, [message]) },
  }
}

/**
 * The conversation a bot's message places its "working" row in (null: already there, or the message
 * says nothing about the chat it works in). Session messages come from a lane running in parallel with
 * the chat's, and activity cards update on every action: the lane's own `bot.status` places those.
 */
export function noteBotConversation(
  botConversation: Record<string, string | undefined>,
  message: Message,
  conversation: ConversationSummary | undefined,
): Record<string, string | undefined> | null {
  const botId = message.authorBotId
  if (!botId || message.kind === 'activity' || conversation?.type === 'session') return null
  if (botConversation[botId] === message.conversationId) return null
  return { ...botConversation, [botId]: message.conversationId }
}

/** Bots asked to reply show as working at once, until the daemon reports a status for them. */
export function markPendingReplies(
  state: PendingState,
  conversationId: string,
  botIds: string[],
  at: number,
): PendingState | null {
  const known = botIds.filter((id) => state.bots[id])
  if (known.length === 0) return null
  const pendingReplies = { ...state.pendingReplies }
  const botConversation = { ...state.botConversation }
  const bots = { ...state.bots }
  for (const botId of known) {
    const bot = bots[botId] as Bot
    pendingReplies[botId] = { conversationId, at }
    botConversation[botId] = conversationId
    if (bot.status === 'idle') bots[botId] = { ...bot, status: 'thinking' }
  }
  return { pendingReplies, botConversation, bots }
}

/** Drops optimistic entries created at `at` that the daemon never confirmed (null: nothing to drop). */
export function clearPendingReplies(
  state: Pick<PendingState, 'pendingReplies' | 'bots'>,
  botIds: string[],
  at: number,
): Pick<PendingState, 'pendingReplies' | 'bots'> | null {
  const pendingReplies = { ...state.pendingReplies }
  const bots = { ...state.bots }
  let changed = false
  for (const botId of botIds) {
    if (pendingReplies[botId]?.at !== at) continue
    delete pendingReplies[botId]
    const bot = bots[botId]
    if (bot?.status === 'thinking') bots[botId] = { ...bot, status: 'idle' }
    changed = true
  }
  return changed ? { pendingReplies, bots } : null
}
