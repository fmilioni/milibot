import type { Bot, Message } from '@milibot/shared'

import type { TurnRequest, WorkSessionView } from '../../environment'
import type { ContentPart } from '../../llm/messages'
import { instructionText, isInstructionCard, isRoutineRun, messageToChat } from '../../memory/chat-messages'
import { conversationNote } from '../../prompts/notes'
import type { HostContext } from '../context'
import { routineInstructions } from '../read-tracking'
import type { LaneState } from '../state'

/** What a chat turn has not read yet (marked read once taken). */
export interface UnreadChat {
  messages: Message[]
  pending: Message[]
  /** The instructions of a routine run whose card the bot already read past (it replied to something else). */
  missedRoutine: string | null
}

/**
 * The one place that decides what a turn reads besides the conversation itself, in the same order for every
 * engine: the documents relevant to it, then Milibot's notes (the conversation, the bot's other work or the
 * session's steps, the request's own note, a missed routine run), then what arrived.
 */
export class TurnInput {
  constructor(private readonly ctx: HostContext) {}

  /** Takes the chat's unread messages, marking them read. */
  takeUnread(bot: Bot, request: TurnRequest): UnreadChat {
    const { messages, pending } = this.ctx.reads.pendingMessages(bot, request.conversationId)
    this.ctx.reads.markRead(bot.id, request.conversationId, messages)
    return {
      messages,
      pending,
      missedRoutine: pending.some(isRoutineRun) ? null : routineInstructions(request, messages),
    }
  }

  /** Documents relevant to the turn ('' when none), from what it reads and its note. */
  knowledge(
    bot: Bot,
    request: TurnRequest,
    lane: LaneState,
    signal: AbortSignal,
    where: { session: WorkSessionView | null; projectId?: string | null; query: string },
  ): Promise<string> {
    const projectId = where.session ? where.session.projectId : (where.projectId ?? null)
    const kind = where.session ? 'session' : lane.info.kind
    return this.ctx.knowledge.forTurn(bot, [where.query, request.note], signal, projectId, kind)
  }

  /** Milibot's notes for the turn, in reading order ('' notes left out). */
  notes(
    bot: Bot,
    request: TurnRequest,
    lane: LaneState,
    session: WorkSessionView | null,
    missedRoutine?: string | null,
  ): string[] {
    if (session) return [this.ctx.sessions.stateNote(session), request.note ?? ''].filter(Boolean)
    const conversation = this.ctx.env().getConversation(request.conversationId)
    return [
      conversation ? conversationNote(conversation, bot, this.ctx.botsById()) : null,
      this.ctx.otherWork.note(bot.id, lane.info.key, request.conversationId),
      request.note,
      missedRoutine,
    ].filter((note): note is string => Boolean(note))
  }

  /** The knowledge block and the notes, in reading order. */
  async head(
    bot: Bot,
    request: TurnRequest,
    lane: LaneState,
    signal: AbortSignal,
    where: {
      session: WorkSessionView | null
      projectId?: string | null
      query: string
      missedRoutine?: string | null
    },
  ): Promise<string[]> {
    const knowledge = await this.knowledge(bot, request, lane, signal, where)
    return [knowledge, ...this.notes(bot, request, lane, where.session, where.missedRoutine)].filter(Boolean)
  }

  /** Messages of a chat that arrived after the turn read it, as the parts of one input (marked read). */
  unreadParts(bot: Bot, conversationId: string): ContentPart[] {
    const { messages, pending } = this.ctx.reads.pendingMessages(bot, conversationId)
    this.ctx.reads.markRead(bot.id, conversationId, messages)
    const botsById = this.ctx.botsById()
    return pending.flatMap((m) => {
      if (m.authorBotId === bot.id) return []
      const chat = messageToChat(m, bot, botsById)
      return chat?.role === 'user' ? chat.content : []
    })
  }

  /** Messages as the lines of a CLI engine's input (text only; a session's brief is in its bootstrap). */
  lines(bot: Bot, pending: Message[], inSession: boolean): string[] {
    const botsById = this.ctx.botsById()
    return pending.flatMap((m) => {
      if (isInstructionCard(m)) {
        if (inSession && m.payload?.type === 'session_brief') return []
        const text = instructionText(m, bot)
        return text ? [text] : []
      }
      if (m.kind !== 'text' || !m.content.trim() || m.authorBotId === bot.id) return []
      return [
        m.authorType === 'user'
          ? m.content
          : `[${botsById.get(m.authorBotId ?? '')?.name ?? 'Bot'}]: ${m.content}`,
      ]
    })
  }
}
