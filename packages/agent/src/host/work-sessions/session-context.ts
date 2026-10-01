import { type Bot, type CliEngine, estimateTokens } from '@milibot/shared'

import type { CliStartup } from '../../cli/startup'
import type { TurnRequest, WorkSessionView } from '../../environment'
import type { ChatMessage, ContentPart } from '../../llm/messages'
import { memoryDigest } from '../../memory/bootstrap'
import { messageToChat } from '../../memory/chat-messages'
import { formatMemoryBlock, formatWorkspaceMemoryBlock } from '../../memory/context-builder'
import { SESSION_INTERRUPTED_NOTE, sessionStateNote } from '../../prompts/notes'
import { sessionConversation } from '../../work-sessions/transcript'
import type { HostContext } from '../context'
import type { LaneKey } from '../lanes'
import type { LaneState, TurnState } from '../state'

export interface SessionTranscript {
  summary: string | null
  /** Stored seq of each entry of the conversation (-1: not stored, the rolling summary). */
  seqs: number[]
}

/** What a work session's lanes read: the fixed part of their prompt, new messages, where the steps stand. */
export class SessionContext {
  constructor(private readonly ctx: HostContext) {}

  /** The work session of a session lane (or of a session helper's lane); null for the chat's lanes. */
  laneSession(lane: LaneState): WorkSessionView | null {
    if (lane.info.kind === 'main' || !lane.info.sessionId) return null
    const env = this.ctx.env()
    try {
      return env.workSessions.get(lane.info.sessionId)
    } catch (err) {
      env.log('warn', 'work session lookup failed', { laneKey: lane.info.key, err: (err as Error).message })
      return null
    }
  }

  /** The lane's session for a turn; `missing` when the lane belongs to a session that is gone. */
  forTurn(bot: Bot, lane: LaneState): { session: WorkSessionView | null } | 'missing' {
    const session = this.laneSession(lane)
    if (lane.info.sessionId && !session) {
      this.ctx
        .env()
        .log('warn', 'work session of the lane not found', { botId: bot.id, laneKey: lane.info.key })
      return 'missing'
    }
    return { session }
  }

  /**
   * What stays fixed for a session lane (the second cached part of its prompt): the brief, the project,
   * the general knowledge catalog, the workspace memory and the bot's pinned notes.
   */
  fixed(bot: Bot, session: WorkSessionView): { text: string; memoryTokens: number } {
    const env = this.ctx.env()
    const config = this.ctx.memory.config()
    const project = session.projectId
      ? this.ctx.knowledge.currentProject(bot, session.conversationId, 'session')
      : null
    const workspace = formatWorkspaceMemoryBlock(
      env.memory.workspaceNotes(),
      config.workspaceMemoryBudgetTokens,
    )
    const pinned = formatMemoryBlock(env.memory.pinnedNotes(bot.id), config.memoryBudgetTokens)
    const text = [
      session.brief,
      project?.block ?? '',
      this.ctx.knowledge.catalog(bot, 'session'),
      workspace.text,
      pinned.text,
    ]
      .map((t) => t.trim())
      .filter(Boolean)
      .join('\n\n')
    return { text, memoryTokens: estimateTokens(workspace.text) + estimateTokens(pinned.text) }
  }

  /** What arrived in the session's conversation since the lane last read it, as parts of one input. */
  newMessages(bot: Bot, session: WorkSessionView, laneKey: LaneKey): ContentPart[] {
    const env = this.ctx.env()
    const after = env.workSessions.inputSeq(laneKey)
    const fresh = env.memory.messagesAfter(session.conversationId, after, { limit: 200 })
    const botsById = this.ctx.botsById()
    const parts: ContentPart[] = []
    let last = after
    for (const message of fresh) {
      last = Math.max(last, message.seq)
      // The brief is in the fixed part of the prompt; the bot's own replies are in its transcript.
      if (message.payload?.type === 'session_brief') continue
      if (message.authorType === 'bot' && message.authorBotId === bot.id) continue
      const chat = messageToChat(message, bot, botsById)
      if (chat?.role === 'user') parts.push(...chat.content)
    }
    if (last !== after) env.workSessions.setInputSeq(laneKey, last)
    return parts
  }

  /** Current steps of the session, for the input of a turn ('' without steps). */
  stateNote(session: WorkSessionView): string {
    try {
      return sessionStateNote(this.ctx.env().workSessions.state(session.id))
    } catch {
      return ''
    }
  }

  /**
   * Context of a native turn in a session lane: system (rules + persona + session rules | brief, project,
   * catalog, memory), then the lane's stored transcript (rolling summary + entries) and the new input,
   * stored before the loop starts.
   */
  async nativeContext(
    bot: Bot,
    session: WorkSessionView,
    lane: LaneState,
    request: TurnRequest,
    turn: TurnState,
    systemPrompt: string,
  ): Promise<{
    system: ChatMessage
    systemText: string
    conversation: ChatMessage[]
    transcript: SessionTranscript
  }> {
    const directory = this.ctx.env().workSessions
    const fixed = this.fixed(bot, session)
    const system: ChatMessage = {
      role: 'system',
      content: [
        { type: 'text', text: systemPrompt, cacheBreakpoint: true },
        ...(fixed.text ? [{ type: 'text' as const, text: fixed.text, cacheBreakpoint: true }] : []),
      ],
    }
    const stored = directory.loadTranscript(session.id, lane.info.key)
    const { conversation, seqs } = sessionConversation(stored)
    const append = (message: ChatMessage) => {
      conversation.push(message)
      seqs.push(directory.appendTranscript(session.id, lane.info.key, turn.id, message))
    }
    // A turn cut in the middle of its tool calls (crash, restart) left calls without results.
    const lastCall = conversation.findLastIndex((m) => m.role === 'assistant' && m.toolCalls?.length)
    if (lastCall >= 0) {
      const answered = new Set(
        conversation.slice(lastCall + 1).flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
      )
      const assistant = conversation[lastCall] as Extract<ChatMessage, { role: 'assistant' }>
      for (const call of assistant.toolCalls ?? []) {
        if (answered.has(call.id)) continue
        append({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: SESSION_INTERRUPTED_NOTE }],
          isError: true,
        })
      }
    }
    const parts = this.newMessages(bot, session, lane.info.key)
    const typed = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    const head = await this.ctx.inputs.head(bot, request, lane, turn.abort.signal, { session, query: typed })
    const input: ContentPart[] = [...head.map((text): ContentPart => ({ type: 'text', text })), ...parts]
    if (input.length === 0) input.push({ type: 'text', text: '(continue)' })
    append({ role: 'user', content: input })
    return {
      system,
      systemText: `${systemPrompt}\n\n${fixed.text}`,
      conversation,
      transcript: { summary: stored.summary, seqs },
    }
  }

  /**
   * Bootstrap of a session lane's CLI process: session brief, project, general catalog, workspace
   * memory and pinned notes, kept identical across resumes. A fresh CLI session after an earlier one (lost
   * or rotated) also gets how far the work went.
   */
  cliStartup(
    engine: CliEngine,
    bot: Bot,
    session: WorkSessionView,
    laneKey: LaneKey,
  ): (fresh: boolean) => CliStartup {
    return (fresh) => {
      const env = this.ctx.env()
      if (!fresh) {
        const stored = env.hostState.cliBootstrap(engine, laneKey)
        if (stored) return { systemAppendix: stored.appendix, inputPrefix: null, sections: stored.sections }
      }
      const earlier = env.workSessions.cliStarted(session.id)
      const fixed = this.fixed(bot, session)
      const recovery = earlier > 0 ? env.workSessions.recovery(session.id) : ''
      const appendix = [fixed.text, recovery].filter(Boolean).join('\n\n')
      const sections = { longTermMemory: fixed.memoryTokens, summaries: 0, recap: estimateTokens(recovery) }
      env.hostState.setCliBootstrap(engine, laneKey, { appendix, digest: memoryDigest(appendix), sections })
      return { systemAppendix: appendix, inputPrefix: null, sections }
    }
  }
}
