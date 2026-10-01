import type { TurnRequest } from '../../environment'
import { endedSessionNote } from '../../prompts/notes'
import type { HostContext } from '../context'
import { internalLaneKey, isBotLane, type LaneKey, sessionLaneKey } from '../lanes'
import { type BotState, type LaneState, StoppedError, type TurnState } from '../state'

/** Helpers of one session (or of the chat) running at once (more wait in their lanes' queues). */
const SUBAGENTS_AT_ONCE = 3

export function userTurn(botId: string, conversationId: string): TurnRequest {
  return { botId, conversationId, trigger: 'user_message' }
}

const readsConversation = (trigger: TurnRequest['trigger']) =>
  trigger === 'user_message' || trigger === 'group_message'

/** The lanes' queues and the parallel slots their turns run in. */
export class Scheduler {
  private active = 0
  /** Daily spend limit reached: no turn starts and API turns wait before their next LLM call. */
  private held = false
  private heldWaiters: Array<() => void> = []
  private idleWaiters: Array<() => void> = []

  constructor(private readonly ctx: HostContext) {}

  enqueue(original: TurnRequest): void {
    if (!this.ctx.running()) return
    const request = this.redirectEnded(original)
    const lane = this.ctx.lanes.lane(this.laneKeyFor(request))
    request.laneKey = lane.info.key
    if (this.joinRunningTurn(lane, request)) return
    const duplicate = lane.queue.find(
      (q) =>
        q.conversationId === request.conversationId &&
        (q.trigger === request.trigger ||
          (readsConversation(q.trigger) && readsConversation(request.trigger))),
    )
    if (duplicate) {
      if (request.botRequests?.length)
        duplicate.botRequests = [...(duplicate.botRequests ?? []), ...request.botRequests]
      if (request.note)
        duplicate.note = duplicate.note ? `${duplicate.note}\n\n${request.note}` : request.note
      if (request.onFinished) {
        const first = duplicate.onFinished
        const second = request.onFinished
        duplicate.onFinished = (outcome) => {
          first?.(outcome)
          second(outcome)
        }
      }
    } else if (request.trigger === 'user_message') {
      // The user goes ahead of work other bots, routines or sessions queued for this lane.
      const firstOther = lane.queue.findIndex((q) => q.trigger !== 'user_message')
      if (firstOther < 0) lane.queue.push(request)
      else lane.queue.splice(firstOther, 0, request)
    } else {
      lane.queue.push(request)
    }
    // Busy from the moment the request is accepted, even while it waits for a free slot.
    if (!lane.running) this.ctx.lanes.setStatus(lane, 'thinking')
    this.pump()
  }

  /**
   * A user message in the conversation the lane's turn is working on joins that turn (read at its next step,
   * or before it ends), like a person adding to what they asked while it is being done. If the turn ends
   * without reading it, it is queued again (`turn.incoming`).
   */
  private joinRunningTurn(lane: LaneState, request: TurnRequest): boolean {
    const turn = lane.current
    if (request.trigger !== 'user_message' || !turn?.joinable) return false
    if (turn.conversationId !== request.conversationId || turn.abort.signal.aborted) return false
    if (request.note || request.botRequests?.length || request.onFinished) return false
    turn.incoming = true
    turn.deliver?.()
    return true
  }

  /**
   * What reaches a work session after it ended (a late reply from a bot it messaged) goes to the conversation
   * it started from: the session stays closed. A user writing in it reopens it before this runs.
   */
  private redirectEnded(request: TurnRequest): TurnRequest {
    const ended = this.ctx.env().workSession(request.conversationId)?.ended
    if (!ended) return request
    const { laneKey: _sessionLane, ...rest } = request
    const note = endedSessionNote(ended.title)
    return {
      ...rest,
      conversationId: ended.originConversationId,
      note: request.note ? `${note}\n\n${request.note}` : note,
    }
  }

  /** The request's own lane, else the lane of the work session its conversation belongs to, else the chat's. */
  private laneKeyFor(request: TurnRequest): LaneKey {
    if (request.laneKey && isBotLane(request.laneKey, request.botId)) return request.laneKey
    const env = this.ctx.env()
    const session = env.workSession(request.conversationId)
    if (session) return sessionLaneKey(request.botId, session.sessionId)
    // Requests from other bots run beside the chat, so the user is never queued behind them.
    if (env.getConversation(request.conversationId)?.type === 'internal')
      return internalLaneKey(request.botId)
    return request.botId
  }

  dropQueue(lane: LaneState): void {
    const dropped = lane.queue
    lane.queue = []
    for (const request of dropped) request.onFinished?.('cancelled')
  }

  /** Drops the lane's queue and stops its turn; `mark`: late tool calls are refused until a turn starts. */
  abortLane(lane: LaneState, mark = false): void {
    this.dropQueue(lane)
    if (mark) lane.stopped = true
    lane.current?.abort.abort(new StoppedError())
  }

  /** Stops one lane (a helper whose parent turn was stopped). */
  stopLane(key: LaneKey): void {
    const lane = this.ctx.lanes.findLane(key)
    if (lane) this.abortLane(lane, true)
  }

  isHeld(): boolean {
    return this.held
  }

  hold(held: boolean): void {
    if (this.held === held) return
    this.held = held
    if (held) return
    const waiters = this.heldWaiters
    this.heldWaiters = []
    for (const waiter of waiters) waiter()
    this.pump()
  }

  waitUnheld(signal: AbortSignal): Promise<void> {
    if (!this.held) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
      this.heldWaiters.push(done)
    })
  }

  private runningSessionLanes(): number {
    let count = 0
    for (const lane of this.ctx.lanes.allLanes())
      if (lane.info.kind !== 'main' && lane.running && lane.detached === 0) count++
    return count
  }

  private runningSubagents(parentKey: LaneKey | null): number {
    let count = 0
    for (const lane of this.ctx.lanes.allLanes())
      if (lane.info.kind === 'subagent' && lane.info.parentKey === parentKey && lane.running) count++
    return count
  }

  /** Starts queued turns while there are free slots: chat lanes first. */
  pump(): void {
    if (this.held) return
    const settings = this.ctx.settings
    for (const chat of [true, false]) {
      for (const [, state] of this.ctx.lanes.botStates()) {
        for (const lane of state.lanes.values()) {
          if ((lane.info.kind === 'main') !== chat) continue
          if (this.active >= settings.maxParallel()) continue
          if (lane.running || state.paused || lane.queue.length === 0) continue
          // Session lanes leave the chat a slot.
          if (!chat && this.runningSessionLanes() >= settings.maxParallelSessions()) continue
          if (
            lane.info.kind === 'subagent' &&
            this.runningSubagents(lane.info.parentKey) >= SUBAGENTS_AT_ONCE
          )
            continue
          this.startTurn(lane)
        }
      }
    }
  }

  private startTurn(lane: LaneState): void {
    const request = lane.queue.shift() as TurnRequest
    lane.running = true
    this.active++
    void this.ctx.turns
      .run(lane, request)
      .catch((err: unknown) =>
        this.ctx.env().log('error', 'turn crashed', { botId: lane.info.botId, err: (err as Error).message }),
      )
      .finally(() => {
        lane.running = false
        lane.current = null
        this.active--
        this.ctx.screen.release(lane)
        this.ctx.lanes.setStatus(lane, lane.queue.length ? 'thinking' : 'idle')
        if (lane.info.kind === 'subagent' && lane.queue.length === 0) this.forgetEphemeralLane(lane)
        if (lane.queue.length === 0) this.ctx.otherWork.laneFreed(lane)
        this.pump()
        this.notifyIdle()
      })
  }

  /** A helper's lane ends with its work: its CLI process and session go with it. */
  private forgetEphemeralLane(lane: LaneState): void {
    this.ctx.lanes.removeLane(lane)
    void Promise.all([...this.ctx.cli.values()].map((sessions) => sessions.rotate(lane.info.key))).catch(
      (err: unknown) =>
        this.ctx.env().log('warn', 'helper process close failed', {
          laneKey: lane.info.key,
          err: (err as Error).message,
        }),
    )
  }

  /**
   * Waits for `wait` without holding the turn's parallel slot, so other bots (or the one being waited on)
   * can run. Parallel waits of one turn (CLI engines' MCP calls) give the slot back once.
   */
  async detached<T>(lane: LaneState, turn: TurnState | null, wait: Promise<T>, kind?: string): Promise<T> {
    const holdsSlot = Boolean(turn && lane.running && lane.current === turn)
    if (holdsSlot && lane.detached++ === 0) {
      this.active--
      this.pump()
    }
    if (kind) this.ctx.lanes.setStatus(lane, 'working', kind)
    try {
      return await wait
    } finally {
      if (holdsSlot && --lane.detached === 0) this.active++
    }
  }

  notifyIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) waiter()
  }

  async idle(botId?: string): Promise<void> {
    // Turns queued for a paused bot wait for the user, not for the runtime.
    const busyState = (s: BotState | undefined) =>
      Boolean(s && [...s.lanes.values()].some((l) => l.running || (l.queue.length && !s.paused)))
    const busy = () =>
      botId
        ? busyState(this.ctx.lanes.find(botId))
        : [...this.ctx.lanes.botStates()].some(([, state]) => busyState(state))
    for (;;) {
      while (busy()) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
      const pending = this.ctx.memory.pending(botId)
      if (!botId) pending.push(...this.ctx.routing.pending())
      if (pending.length === 0 && !busy()) return
      await Promise.allSettled(pending)
    }
  }
}
