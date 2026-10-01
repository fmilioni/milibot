import { type Bot, type Message, newId } from '@milibot/shared'

import { isCliModel, type TurnOutcome, type TurnRequest } from '../../environment'
import type { HostContext } from '../context'
import { TurnEngines } from '../engines'
import { userTurn } from '../scheduling/scheduler'
import { HISTORY_MESSAGES, isAbort, type LaneState, type TurnState } from '../state'

/** One turn from its request to its outcome: model, engine, the activity card's end and what follows it. */
export class TurnRunner {
  private readonly engines: TurnEngines

  constructor(private readonly ctx: HostContext) {
    this.engines = new TurnEngines(ctx)
  }

  async run(lane: LaneState, request: TurnRequest): Promise<void> {
    const ctx = this.ctx
    const env = ctx.env()
    const bot = env.getBot(request.botId)
    const conversation = env.getConversation(request.conversationId)
    if (!bot || !conversation) {
      for (const id of request.botRequests ?? []) ctx.messaging.finish(id, '')
      request.onFinished?.('cancelled')
      return
    }
    if (ctx.reads.nothingToAnswer(bot, request, Boolean(lane.info.sessionId))) {
      request.onFinished?.('done')
      return
    }
    if (lane.info.kind === 'session' && env.workSession(conversation.id)?.ended) {
      // Queued before the session ended: it runs where the session started.
      ctx.scheduler.enqueue(request)
      return
    }
    const turn = this.newTurn(bot, lane, request)
    const helper = ctx.helpers.get(lane.info.key)
    if (helper)
      turn.capture = (text) => {
        helper.report = text
      }
    lane.current = turn
    lane.stopped = false
    ctx.lanes.setStatus(lane, 'thinking')

    let crashed = false
    try {
      if (request.waitFor) await request.waitFor.catch(() => undefined)
      if (lane.info.sessionId)
        await env.workSessions.ensureReady(lane.info.sessionId).catch((err: unknown) =>
          env.log('warn', 'work session folder not ready', {
            laneKey: lane.info.key,
            err: (err as Error).message,
          }),
        )
      if (turn.abort.signal.aborted) return
      let resolved = await env.resolveModel(bot, { laneKey: lane.info.key, model: request.model })
      if (isCliModel(resolved) && env.providerExhausted(resolved.providerId)) {
        const fallback = await env.resolveFallbackModel(bot).catch(() => null)
        if (fallback && fallback.kind !== 'unavailable') {
          env.log('info', 'subscription quota exhausted: turn runs on the fallback model', { botId: bot.id })
          resolved = fallback
        }
      }
      if (resolved.kind === 'unavailable') {
        this.errorCard(turn, resolved.code, resolved.reason)
        return
      }
      await this.engines.run({ bot, request, turn }, resolved)
    } catch (err) {
      if (isAbort(err, turn.abort.signal)) return
      crashed = true
      env.log('error', 'turn crashed', { botId: bot.id, err: (err as Error).message })
      this.errorCard(turn, 'turn_crashed', (err as Error).message)
    } finally {
      const outcome = this.finish(turn, crashed)
      request.onFinished?.(outcome)
      // A helper's turn is part of its session's: it is not a turn of the chat, nor a reply to anyone.
      if (!helper) this.turnEnded(bot, request, turn, outcome)
      // A message that joined the turn after its last step waits for the next one.
      if (turn.incoming && outcome !== 'cancelled')
        ctx.scheduler.enqueue(userTurn(bot.id, turn.conversationId))
    }
    // Session lanes keep their own transcript (compacted inside the loop).
    if (!lane.info.sessionId && lane.info.kind !== 'subagent')
      ctx.memory.scheduleCompaction(bot.id, conversation.id)
  }

  private newTurn(bot: Bot, lane: LaneState, request: TurnRequest): TurnState {
    return {
      id: newId('turn'),
      botId: bot.id,
      startedAt: this.ctx.env().now(),
      laneKey: lane.info.key,
      conversationId: request.conversationId,
      abort: new AbortController(),
      activityMessageId: null,
      steps: [],
      text: null,
      lastText: null,
      lastFolded: null,
      consecutiveErrors: 0,
      llmCallId: null,
      chain: request.chain ?? [],
      hops: request.hops ?? 0,
      capture: null,
      helpersStarted: 0,
      joinable: lane.info.kind === 'main' || lane.info.kind === 'session',
      incoming: false,
      deliver: null,
    }
  }

  /** Closes the turn's activity card and tells how it went. */
  private finish(turn: TurnState, crashed: boolean): TurnOutcome {
    const activity = this.ctx.activity
    turn.joinable = false
    turn.deliver = null
    const stopped = turn.abort.signal.aborted
    const activityStatus = stopped
      ? 'cancelled'
      : crashed
        ? 'error'
        : turn.steps.some((s) => s.status === 'error') && turn.steps.at(-1)?.status === 'error'
          ? 'error'
          : 'done'
    for (const step of turn.steps) {
      if (step.status === 'running') activity.finishStep(step, 'cancelled', null)
    }
    if (!stopped && !crashed) activity.unfoldLastNote(turn)
    activity.syncActivity(turn, activityStatus)
    if (stopped) return 'cancelled'
    return crashed || turn.failed || activityStatus === 'error' ? 'error' : 'done'
  }

  /** Posts an error card for the turn (a helper's failure goes to its report instead). */
  errorCard(turn: TurnState, code: string, detail: string, params?: Record<string, string>): void {
    turn.failed = true
    const helper = this.ctx.helpers.get(turn.laneKey)
    if (helper) {
      helper.failure = detail
      return
    }
    this.ctx.env().appendMessage({
      conversationId: turn.conversationId,
      authorType: 'bot',
      authorBotId: turn.botId,
      kind: 'card',
      content: detail,
      payload: { type: 'error', code, detail, ...(params ? { params } : {}) },
      turnId: turn.id,
    })
  }

  private turnEnded(bot: Bot, request: TurnRequest, turn: TurnState, outcome: TurnOutcome): void {
    const env = this.ctx.env()
    const texts = this.turnTexts(turn)
    const reply = texts
      .map((m) => m.content.trim())
      .join('\n\n')
      .trim()
    try {
      env.turnFinished({
        botId: bot.id,
        conversationId: turn.conversationId,
        turnId: turn.id,
        trigger: request.trigger,
        routineId: request.routineId ?? null,
        outcome,
        reply,
      })
    } catch (err) {
      env.log('warn', 'turn finished hook failed', { botId: bot.id, err: (err as Error).message })
    }
    try {
      this.afterTurn(bot, request, turn, texts, reply)
    } catch (err) {
      env.log('warn', 'post-turn routing failed', { botId: bot.id, err: (err as Error).message })
    }
  }

  /** Text messages the bot wrote in this turn. */
  private turnTexts(turn: TurnState): Message[] {
    return this.ctx
      .env()
      .recentMessages(turn.conversationId, HISTORY_MESSAGES)
      .filter(
        (m) =>
          m.authorBotId === turn.botId &&
          m.kind === 'text' &&
          m.payload?.type === 'text' &&
          m.payload.turnId === turn.id &&
          m.content.trim(),
      )
  }

  /** Delivers the turn's reply to bots that asked for it and lets the group react to it. */
  private afterTurn(bot: Bot, request: TurnRequest, turn: TurnState, texts: Message[], reply: string): void {
    const { messaging, routing } = this.ctx
    for (const id of request.botRequests ?? []) messaging.finish(id, reply)
    if (texts.length === 0) return
    const conversation = this.ctx.env().getConversation(turn.conversationId)
    const stopped = turn.abort.signal.aborted || !this.ctx.running()
    if (conversation?.type === 'internal') {
      if (!request.botRequests?.length && !stopped) messaging.followUp(bot, turn, conversation, reply)
      return
    }
    if (conversation?.type === 'group') routing.botSpoke(bot, conversation, texts.at(-1) as Message, stopped)
  }
}
