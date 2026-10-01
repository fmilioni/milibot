import type { Bot, Message } from '@milibot/shared'

import type { TurnRequest } from '../environment'
import { isInstructionCard, isRoutineRun } from '../memory/chat-messages'
import type { HostContext } from './context'
import { HISTORY_MESSAGES } from './state'

/** What each bot has read of each conversation, so a turn reads only what came after its last one. */
export class ReadTracker {
  /** `botId:conversationId` → newest message there when the bot's last turn built its input. */
  private readonly lastRead = new Map<string, string>()

  constructor(private readonly ctx: HostContext) {}

  /**
   * Messages of the conversation the bot has not read yet: after the newest one its last turn there read
   * (messages that arrived during that turn come before its reply but were never seen), else after its
   * last reply.
   */
  pendingMessages(bot: Bot, conversationId: string): { messages: Message[]; pending: Message[] } {
    const messages = this.ctx.env().recentMessages(conversationId, HISTORY_MESSAGES)
    const readId = this.lastRead.get(`${bot.id}:${conversationId}`)
    let from = readId ? messages.findIndex((m) => m.id === readId) : -1
    if (from < 0)
      messages.forEach((m, i) => {
        if (m.authorType === 'bot' && m.authorBotId === bot.id && m.kind === 'text') from = i
      })
    return { messages, pending: messages.slice(from + 1) }
  }

  markRead(botId: string, conversationId: string, messages?: Message[]): void {
    const newest = (messages ?? this.ctx.env().recentMessages(conversationId, 1)).at(-1)
    if (newest) this.lastRead.set(`${botId}:${conversationId}`, newest.id)
  }

  /**
   * A conversation turn with nothing to answer: every message that woke it was already answered by a turn
   * that ended meanwhile (e.g. a group message that arrived while the bot was replying).
   */
  nothingToAnswer(bot: Bot, request: TurnRequest, inSession: boolean): boolean {
    if (request.trigger !== 'user_message' && request.trigger !== 'group_message') return false
    if (request.note || request.botRequests?.length || inSession) return false
    const { pending } = this.pendingMessages(bot, request.conversationId)
    return !pending.some(
      (m) =>
        isInstructionCard(m) || (m.kind === 'text' && m.authorBotId !== bot.id && m.content.trim() !== ''),
    )
  }
}

/**
 * The instructions of this routine turn's run when the bot replied to something else after the
 * card was posted (the card is then before its last reply, not in the new input).
 */
export function routineInstructions(request: TurnRequest, messages: Message[]): string | null {
  if (request.trigger !== 'routine' || !request.routineId) return null
  const card = messages.findLast((m) => isRoutineRun(m) && m.payload.routineId === request.routineId)
  return card?.content.trim() ? card.content : null
}
