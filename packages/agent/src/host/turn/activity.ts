import {
  type ActivityPayload,
  type ActivityStep,
  type Bot,
  type BotActivityAction,
  type Message,
  newId,
} from '@milibot/shared'

import { describeCliTool } from '../../cli/tools'
import { milibotToolName } from '../../mcp/names'
import { activityLine } from '../../tools/describe'
import { DRAFT_TOOLS } from '../../tools/families/design'
import type { HostContext } from '../context'
import type { TurnState } from '../state'
import { TextStream } from './text-stream'

/** Streamed tool input reaches `toolInputDraft` at most this often per call (the daemon throttles its work too). */
const DRAFT_FORWARD_MS = 200

/** A turn's activity card and text messages, and the bot's activity log (`bot.activity`). */
export class TurnActivity {
  /** Unclipped detail of running steps, for the activity log. */
  private readonly fullDetails = new Map<string, string>()

  constructor(private readonly ctx: HostContext) {}

  readonly mcpServerName = (slug: string): string | null => this.ctx.env().mcpServerName(slug)

  setFullDetail(toolCallId: string, detail: string): void {
    this.fullDetails.set(toolCallId, detail)
  }

  private payload(turn: TurnState, status: ActivityPayload['status']): ActivityPayload {
    return { type: 'activity', turnId: turn.id, status, steps: turn.steps }
  }

  private summary(turn: TurnState): string {
    return turn.steps.map((s) => activityLine(s.kind, s.detail)).join('\n')
  }

  /**
   * Text the bot wrote before a tool call is narration, not the reply: it leaves the chat and becomes a
   * collapsed note in the turn's activity card. Only the turn's last text stays as a chat message.
   */
  foldNarration(turn: TurnState): void {
    const streaming = turn.text?.started ? turn.text.end() : null
    if (streaming?.content.trim()) turn.lastText = { messageId: streaming.id, text: streaming.content.trim() }
    const segment = turn.lastText
    if (!segment) return
    turn.lastText = null
    this.ctx.env().deleteMessage(segment.messageId)
    this.addNote(turn, segment.text)
  }

  addNote(turn: TurnState, text: string): void {
    const last = turn.steps.at(-1)
    if (last?.kind === 'note' && (text.startsWith(last.detail) || last.detail.startsWith(text))) {
      if (text.length > last.detail.length) last.detail = text
    } else {
      const now = this.ctx.env().now()
      turn.steps.push({
        toolCallId: newId('toolCall'),
        tool: 'note',
        kind: 'note',
        detail: text,
        status: 'ok',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        error: null,
        screenshotSha: null,
      })
    }
    turn.lastFolded = text
    this.syncActivity(turn, 'running')
  }

  /**
   * The user wrote in the conversation and the turn took it in: what it wrote so far stays as it is (a reply
   * is not folded into a note later) and its next steps go to a new card, below the user's message.
   */
  continueBelow(turn: TurnState): void {
    if (turn.text?.started) this.textEnded(turn, turn.text.end())
    turn.lastText = null
    turn.lastFolded = null
    if (turn.steps.some((s) => s.status === 'running')) return
    if (turn.steps.length) this.syncActivity(turn, 'done')
    turn.steps = []
    turn.activityMessageId = null
  }

  /** A turn that ended with a tool call and no text: its last note is the reply after all. */
  unfoldLastNote(turn: TurnState): void {
    if (turn.lastText || turn.steps.at(-1)?.kind !== 'note') return
    const note = turn.steps.pop() as ActivityStep
    const bot = this.ctx.env().getBot(turn.botId)
    if (!bot) return
    this.textStream(bot, turn).end(note.detail)
  }

  textStream(bot: Bot, turn: TurnState): TextStream {
    return new TextStream(
      this.ctx.env(),
      bot,
      turn.conversationId,
      turn.id,
      this.ctx.options.deltaFlushMs,
      turn.capture,
    )
  }

  /** Remembers a finished text message of the turn (the reply, unless a tool call follows). */
  textEnded(turn: TurnState, message: Message | null): void {
    if (message?.content.trim()) turn.lastText = { messageId: message.id, text: message.content.trim() }
  }

  syncActivity(turn: TurnState, status: ActivityPayload['status']): void {
    // A helper's steps show as one step of its session (and in the screen's activity log).
    if (turn.steps.length === 0 || turn.capture) return
    const env = this.ctx.env()
    if (!turn.activityMessageId) {
      const message = env.appendMessage({
        conversationId: turn.conversationId,
        authorType: 'bot',
        authorBotId: turn.botId,
        kind: 'activity',
        content: this.summary(turn),
        payload: this.payload(turn, status),
        turnId: turn.id,
      })
      turn.activityMessageId = message.id
      return
    }
    env.updateMessage(turn.activityMessageId, {
      content: this.summary(turn),
      payload: this.payload(turn, status),
    })
  }

  emitAction(step: ActivityStep, turn: TurnState | null, botId: string, conversationId: string | null): void {
    const action: BotActivityAction = {
      id: step.toolCallId,
      botId,
      conversationId,
      turnId: turn?.id ?? null,
      time: step.startedAt,
      tool: step.tool,
      kind: step.kind,
      detail: step.detail,
      status: step.status,
      durationMs: step.durationMs,
      error: step.error,
      screenshotSha: step.screenshotSha,
    }
    const full = this.fullDetails.get(step.toolCallId)
    if (full !== undefined && full !== step.detail) action.fullDetail = full
    if (step.status !== 'running') this.fullDetails.delete(step.toolCallId)
    this.ctx.env().emitActivity(action)
  }

  /**
   * Records a tool executed by a CLI engine itself (native tools). Internal tools (ToolSearch,
   * TodoWrite…) are only logged in `tool_calls`; the rest become activity steps.
   */
  startExternalStep(turn: TurnState, id: string, tool: string, input: unknown): ActivityStep | null {
    const env = this.ctx.env()
    const startedAt = env.now()
    env.startToolCall({
      id,
      llmCallId: null,
      botId: turn.botId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      toolName: tool,
      arguments: input,
      startedAt,
    })
    const describe = { mcpServerName: this.mcpServerName }
    const view = describeCliTool(tool, input, describe)
    if (view.hidden) return null
    const full = describeCliTool(tool, input, { ...describe, full: true })
    if (!full.hidden) this.fullDetails.set(id, full.detail)
    const step: ActivityStep = {
      toolCallId: id,
      tool,
      kind: view.kind,
      detail: view.detail,
      status: 'running',
      startedAt,
      finishedAt: null,
      durationMs: null,
      error: null,
      screenshotSha: null,
    }
    turn.steps.push(step)
    this.syncActivity(turn, 'running')
    this.emitAction(step, turn, turn.botId, turn.conversationId)
    return step
  }

  finishStep(step: ActivityStep, status: ActivityStep['status'], error: string | null): void {
    step.status = status
    step.finishedAt = this.ctx.env().now()
    step.durationMs = step.finishedAt - step.startedAt
    step.error = error
  }

  /**
   * Forwards the streamed input of tools that show a draft while being written (a design frame) to the
   * environment; other tool calls are ignored.
   */
  draftForwarder(bot: Bot, turn: TurnState): (id: string, name: string, partialJson: string) => void {
    const sentAt = new Map<string, number>()
    return (id, rawName, partialJson) => {
      const env = this.ctx.env()
      const name = milibotToolName(rawName) ?? rawName
      if (!DRAFT_TOOLS.has(name)) return
      // Wall clock: a rate limit on the daemon's work, not a time the bot sees.
      const now = Date.now()
      if (now - (sentAt.get(id) ?? 0) < DRAFT_FORWARD_MS) return
      sentAt.set(id, now)
      try {
        env.toolInputDraft(
          {
            bot,
            conversationId: turn.conversationId,
            turnId: turn.id,
            laneKey: turn.laneKey,
            toolCallId: id,
          },
          name,
          partialJson,
        )
      } catch (err) {
        env.log('warn', 'tool input draft failed', { botId: bot.id, err: (err as Error).message })
      }
    }
  }
}
