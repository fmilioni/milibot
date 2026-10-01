import { type Bot, clipLine, type ModelChoice } from '@milibot/shared'

import type { ToolResult, TurnOutcome, WorkSessionView } from '../environment'
import type { ToolCall } from '../llm/messages'
import { helperReplies } from '../prompts/tool-replies'
import { argsObject, trimmedString } from '../tools/args'
import { toolError, toolText } from '../tools/result'
import type { HostContext } from './context'
import { type LaneKey, subagentLaneKey } from './lanes'
import { type LaneState, StoppedError, type TurnState } from './state'

const HELPER_BRIEF_CHARS = 6_000

/** A helper (`subagent` tool) doing one task for a work session or the chat, in a lane of its own. */
export interface SubagentRun {
  task: string
  context: string
  readOnly: boolean
  /** Last text it wrote (its report once the turn ends). */
  report: string
  /** Why it could not finish (error card of a normal turn). */
  failure: string | null
}

/** What a helper reads: its task and context, with the session's brief (if any) for reference. */
export function subagentInput(run: SubagentRun, session: WorkSessionView | null): string {
  if (!session)
    return [
      `[Milibot] Your task, from your conversation with the user:\n${run.task}`,
      run.context ? `Context:\n${run.context}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  return [
    `[Milibot] Your task, from the work session "${session.title}":\n${run.task}`,
    run.context ? `Context from the session:\n${run.context}` : '',
    `The session's brief, for reference (do only your task):\n${clipLine(session.brief, HELPER_BRIEF_CHARS, { whitespace: 'trim' })}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The helpers running in the bots' helper lanes. */
export class Subagents {
  private readonly runs = new Map<LaneKey, SubagentRun>()
  /** How many helpers each session has running and started (since the runtime started). */
  private readonly counts = new Map<string, { running: number; total: number }>()
  /** Numbers the lanes of the chat's helpers. */
  private chatHelpers = 0

  constructor(private readonly ctx: HostContext) {}

  /** The helper running in `laneKey`, if it is a helper lane. */
  get(laneKey: LaneKey): SubagentRun | undefined {
    return this.runs.get(laneKey)
  }

  private report(sessionId: string, endedLane?: LaneKey): void {
    const counts = this.counts.get(sessionId) ?? { running: 0, total: 0 }
    const env = this.ctx.env()
    try {
      env.workSessions.subagents(sessionId, { ...counts }, endedLane)
    } catch (err) {
      env.log('warn', 'work session helpers update failed', { sessionId, err: (err as Error).message })
    }
  }

  /**
   * `subagent`: one task in a helper lane (the session's folder, a short context of its own, no chat) whose
   * report is the result. The parent turn waits without its slot; helpers asked for in one response run at
   * the same time (up to SUBAGENTS_AT_ONCE per parent lane, within the parallel limits). The chat's helpers
   * only investigate (read-only): changing things at scale belongs to a work session.
   */
  async run(
    bot: Bot,
    turn: TurnState | null,
    lane: LaneState,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const session = lane.info.kind === 'session' ? this.ctx.sessions.laneSession(lane) : null
    const chatTurn = lane.info.kind === 'main' || lane.info.kind === 'internal' ? turn : null
    if (!session && !chatTurn) return toolError(helperReplies.wrongLane)
    const a = argsObject(call.arguments)
    const task = trimmedString(a.task)
    if (!task) return toolError(helperReplies.missingTask)
    let model: ModelChoice | null = null
    let modelNote = ''
    if (trimmedString(a.model) || trimmedString(a.effort)) {
      const chosen = this.ctx
        .env()
        .resolveModelRequest(
          bot,
          { model: trimmedString(a.model) || null, effort: trimmedString(a.effort) || null },
          lane.info.key,
        )
      if (!chosen.ok) return toolError(chosen.error)
      model = chosen.choice
      modelNote = [`The helper ran on ${chosen.label}.`, ...chosen.notes].join(' ')
    }
    const max = this.ctx.options.maxSubagents
    let key: LaneKey
    let counts: { running: number; total: number } | null = null
    if (session) {
      counts = this.counts.get(session.id) ?? { running: 0, total: 0 }
      if (counts.total >= max) return toolError(helperReplies.sessionLimit(max))
      counts.total++
      counts.running++
      this.counts.set(session.id, counts)
      key = subagentLaneKey(bot.id, session.id, counts.total)
    } else {
      const parent = chatTurn as TurnState
      if (parent.helpersStarted >= max) return toolError(helperReplies.turnLimit(max))
      parent.helpersStarted++
      key = subagentLaneKey(bot.id, null, ++this.chatHelpers)
    }
    const run: SubagentRun = {
      task,
      context: trimmedString(a.context),
      readOnly: !session || a.tools === 'read_only',
      report: '',
      failure: null,
    }
    this.runs.set(key, run)
    if (session) this.report(session.id)
    const stopHelper = () => this.ctx.scheduler.stopLane(key)
    signal.addEventListener('abort', stopHelper, { once: true })
    let outcome: TurnOutcome
    try {
      outcome = await this.ctx.scheduler.detached(
        lane,
        turn,
        new Promise<TurnOutcome>((resolve) =>
          this.ctx.scheduler.enqueue({
            botId: bot.id,
            conversationId: session?.conversationId ?? (chatTurn as TurnState).conversationId,
            trigger: 'subagent',
            laneKey: key,
            model,
            onFinished: resolve,
          }),
        ),
        'subtask',
      )
    } finally {
      signal.removeEventListener('abort', stopHelper)
      this.runs.delete(key)
      if (session && counts) {
        counts.running--
        this.report(session.id, key)
      }
    }
    const report = run.report.trim()
    const activity = {
      detail: clipLine(task, 80),
      fullDetail: [task, report || run.failure].filter(Boolean).join('\n\n'),
      ...(report || run.failure
        ? { result: clipLine(report || (run.failure as string), 4000, { whitespace: 'trim' }) }
        : {}),
    }
    if (outcome === 'cancelled') {
      if (signal.aborted) throw new StoppedError()
      return toolError(helperReplies.stopped(report), activity)
    }
    if (run.failure || !report) return toolError(helperReplies.failed(run.failure, report), activity)
    return toolText(helperReplies.report(report, modelNote), false, activity)
  }
}
