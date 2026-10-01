import {
  type Bot,
  type ConversationSummary,
  groupSettings,
  type Message,
  parseMentions,
} from '@milibot/shared'

import { isBusyStatus } from '@/features/bots/lib/bot-status'

import { toMessageView } from './message-view'

/**
 * Bots certain to pick up a user message (mirrors the daemon): the mentioned members of a group, or
 * its only bot when it answers without mentions. Triage may wake others later.
 */
export function replyTargets(
  conversation: ConversationSummary,
  content: string,
  bots: Record<string, Bot>,
): string[] {
  if (conversation.type === 'internal') return []
  const members = conversation.memberBotIds
  if (conversation.type !== 'group') return [...members]
  const candidates = members.flatMap((id) => bots[id] ?? [])
  const mentioned = parseMentions(content, candidates)
  if (mentioned.length === 0 && members.length === 1 && groupSettings(conversation).respondWithoutMention)
    return [...members]
  return mentioned
}

/**
 * The bot an internal-conversation message wakes: a message a bot sends with ask_bot/message_bot is
 * posted whole (never streamed) and starts a turn of the other member there, if it is free. Replies
 * are streamed and wake nobody in the internal conversation.
 */
export function internalWakeTarget(
  conversation: ConversationSummary | undefined,
  message: Message,
  bots: Record<string, Bot>,
): string | null {
  if (conversation?.type !== 'internal' || message.authorType !== 'bot' || message.kind !== 'text')
    return null
  const view = toMessageView(message)
  if (view.type !== 'text' || view.streaming) return null
  const other = conversation.memberBotIds.find((id) => id !== message.authorBotId)
  const bot = other ? bots[other] : undefined
  return bot && bot.status === 'idle' ? bot.id : null
}

/** A streaming bot text that has not received its first delta yet: shown as the working row instead. */
export function isAwaitingFirstDelta(message: Message): boolean {
  if (message.authorType !== 'bot' || message.content !== '') return false
  const view = toMessageView(message)
  return view.type === 'text' && view.streaming
}

export interface WorkingCandidate {
  botId: string
  /** Optimistic (just sent): show right away instead of waiting out the debounce. */
  immediate: boolean
}

export interface WorkingInput {
  conversation: ConversationSummary
  bots: Record<string, Bot>
  pending: Record<string, { conversationId: string } | undefined>
  /** Conversation each bot last acted in (the daemon's status events carry no conversation). */
  botConversation: Record<string, string | undefined>
  /** Work session a bot's status comes from while its chat lane is idle (not busy in any chat). */
  statusSession?: Record<string, string | undefined>
  /** Status of the session's lane, for a `session` conversation (the bot's own status may be its chat's). */
  lane?: { status: string } | undefined
  messages: Message[]
  /** Whether a bot text is still typing out on screen. */
  isRevealing: (messageId: string) => boolean
}

/**
 * Bots that should show the "Working…" row in this conversation: busy here (or just asked),
 * and not already writing a visible reply.
 */
export function workingCandidates(input: WorkingInput): WorkingCandidate[] {
  const { conversation, bots, pending, botConversation, statusSession, lane, messages, isRevealing } = input
  const result: WorkingCandidate[] = []
  for (const botId of conversation.memberBotIds) {
    const bot = bots[botId]
    if (!bot) continue
    if (bot.status === 'paused') continue
    const immediate = pending[botId]?.conversationId === conversation.id
    const busyHere =
      conversation.type === 'session'
        ? isBusyStatus(lane?.status)
        : isBusyStatus(bot.status) && !statusSession?.[botId] && botConversation[botId] === conversation.id
    if (!immediate && !busyHere) continue
    if (isWritingReply(messages, botId, isRevealing)) continue
    result.push({ botId, immediate })
  }
  return result
}

/**
 * Bots the chat's "Stop" stops: busy on this conversation (or just asked here), including while their
 * reply streams. Stopping is per bot, so a bot working elsewhere is left alone. A DM also offers it when
 * nothing says where its bot works (busy since before the window loaded). In a session it is the
 * session's lane that stops.
 */
export function stoppableBots(
  input: Pick<
    WorkingInput,
    'conversation' | 'bots' | 'pending' | 'botConversation' | 'statusSession' | 'lane'
  >,
): string[] {
  const { conversation, bots, pending, botConversation, statusSession, lane } = input
  if (conversation.type === 'internal') return []
  if (conversation.type === 'session') {
    const asked = conversation.memberBotIds.some((id) => pending[id]?.conversationId === conversation.id)
    return isBusyStatus(lane?.status) || asked ? [...conversation.memberBotIds] : []
  }
  return conversation.memberBotIds.filter((botId) => {
    if (!isBusyStatus(bots[botId]?.status) || statusSession?.[botId]) return false
    const workingIn = pending[botId]?.conversationId ?? botConversation[botId]
    return workingIn === conversation.id || (workingIn === undefined && conversation.type === 'direct')
  })
}

/**
 * Paused bots with a message waiting for them here: the user wrote after the bot's last message (in a
 * group, only the bots that message wakes for sure). They answer when resumed.
 */
export function pausedWaiting(
  conversation: ConversationSummary,
  bots: Record<string, Bot>,
  messages: Message[],
): string[] {
  if (conversation.type === 'internal') return []
  const lastUser = messages.findLast((m) => m.authorType === 'user')
  if (!lastUser) return []
  const targets = replyTargets(conversation, lastUser.content, bots)
  return targets.filter((botId) => {
    if (bots[botId]?.status !== 'paused') return false
    const lastOwn = messages.findLast((m) => m.authorBotId === botId && m.kind === 'text')
    return !lastOwn || lastOwn.createdAt < lastUser.createdAt
  })
}

function isWritingReply(messages: Message[], botId: string, isRevealing: (id: string) => boolean): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Message
    if (message.authorType === 'user') return false
    if (message.authorBotId !== botId) continue
    if (message.kind !== 'text') return false
    const view = toMessageView(message)
    return (view.type === 'text' && view.streaming && message.content !== '') || isRevealing(message.id)
  }
  return false
}
