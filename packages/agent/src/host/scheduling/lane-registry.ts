import type { BotStatus, SystemEventName, SystemPayload } from '@milibot/shared'

import type { HostContext } from '../context'
import { busier, laneInfo, type LaneKey } from '../lanes'
import type { BotState, LaneState, TurnState } from '../state'
import { StatusLog, type StatusReason } from './status-log'

/** The bots' lanes and what the bot shows of them (its status, system lines in its chat). */
export class LaneRegistry {
  private readonly bots = new Map<string, BotState>()
  /** Session lanes this host forgot (their sessions ended) and nothing opened again since. */
  private readonly closedSessions = new Set<LaneKey>()
  readonly log: StatusLog

  constructor(private readonly ctx: HostContext) {
    this.log = new StatusLog(ctx)
  }

  botStates(): IterableIterator<[string, BotState]> {
    return this.bots.entries()
  }

  *allLanes(): Generator<LaneState> {
    for (const state of this.bots.values()) yield* state.lanes.values()
  }

  find(botId: string): BotState | undefined {
    return this.bots.get(botId)
  }

  findLane(key: LaneKey): LaneState | undefined {
    return this.bots.get(laneInfo(key).botId)?.lanes.get(key)
  }

  /** The bot's state, created with its chat lane on first use. */
  bot(botId: string): BotState {
    let state = this.bots.get(botId)
    if (!state) {
      state = {
        lanes: new Map(),
        paused: false,
        userPaused: false,
        takenOver: false,
        needsScreenshot: false,
        pendingNote: false,
        waiters: [],
        status: 'idle',
        statusLane: botId,
        screen: { holder: null, waiters: [] },
      }
      this.bots.set(botId, state)
      this.lane(botId)
    }
    return state
  }

  lane(key: LaneKey): LaneState {
    const info = laneInfo(key)
    const state = this.bot(info.botId)
    let lane = state.lanes.get(key)
    if (!lane) {
      this.closedSessions.delete(key)
      lane = {
        info,
        queue: [],
        running: false,
        current: null,
        stopped: false,
        closed: false,
        detached: 0,
        status: 'idle',
      }
      state.lanes.set(key, lane)
      this.log.laneOpened(info)
    }
    return lane
  }

  laneOf(botId: string, turn: TurnState | null): LaneState {
    return this.lane(turn?.laneKey ?? botId)
  }

  /**
   * A lane that only a late tool call could bring back: a session lane forgotten since, or a helper's (their
   * keys are never reused).
   */
  isGone(key: LaneKey): boolean {
    if (this.findLane(key)) return false
    return laneInfo(key).kind === 'subagent' || this.closedSessions.has(key)
  }

  removeBot(botId: string): void {
    for (const lane of this.bots.get(botId)?.lanes.values() ?? [])
      this.log.laneClosed(lane.info, 'bot_removed')
    this.bots.delete(botId)
    this.log.botRemoved(botId)
    for (const key of this.closedSessions) if (laneInfo(key).botId === botId) this.closedSessions.delete(key)
  }

  /** Forgets the lane; the bot's status no longer counts it. */
  removeLane(lane: LaneState): void {
    const state = this.bots.get(lane.info.botId)
    if (state?.lanes.get(lane.info.key) !== lane) return
    state.lanes.delete(lane.info.key)
    if (lane.info.kind === 'session') this.closedSessions.add(lane.info.key)
    this.log.laneClosed(lane.info)
    this.show(state, lane.info.botId, null, 'remove')
  }

  /** Wakes what waits for the bot to be runnable again (resumed, released or stopped). */
  wake(botId: string): void {
    const state = this.bot(botId)
    const waiters = state.waiters
    state.waiters = []
    for (const waiter of waiters) waiter()
  }

  /** The lane the bot's status shows: the chat lane while it is busy, else the busiest other lane. */
  private shownLane(state: BotState, botId: string): LaneState {
    const main = this.lane(botId)
    if (main.status !== 'idle') return main
    let shown = main
    for (const lane of state.lanes.values()) if (busier(lane.status, shown.status)) shown = lane
    return shown
  }

  setStatus(
    lane: LaneState,
    status: BotStatus,
    detail?: string,
    targetBotId?: string,
    reason?: StatusReason,
  ): void {
    this.log.laneStatus(lane.info, status, reason)
    lane.status = status
    lane.detail = detail
    lane.targetBotId = targetBotId
    const state = this.bots.get(lane.info.botId)
    // A lane already forgotten (reached by a late tool call or wait) shows nowhere.
    if (state?.lanes.get(lane.info.key) !== lane) return
    if (lane.info.kind === 'session' && lane.info.sessionId)
      this.ctx.env().workSessions.laneStatus(lane.info.sessionId, status, detail ?? null)
    this.show(state, lane.info.botId, lane, reason)
  }

  /** A lane no turn runs in any more shows what is left for it: its queue, else nothing. */
  settle(lane: LaneState, reason?: StatusReason): void {
    if (!lane.running)
      this.setStatus(lane, lane.queue.length ? 'thinking' : 'idle', undefined, undefined, reason)
  }

  /** Reports the bot's status from its lanes; `changed`: the lane whose status was just set. */
  private show(state: BotState, botId: string, changed: LaneState | null, reason?: StatusReason): void {
    const shown = this.shownLane(state, botId)
    const own = shown === changed
    const effective = state.userPaused || (state.paused && shown.status !== 'idle') ? 'paused' : shown.status
    if (
      state.status === effective &&
      state.statusLane === shown.info.key &&
      (!own || shown.detail === undefined)
    )
      return
    state.status = effective
    state.statusLane = shown.info.key
    this.log.botStatus(botId, effective, shown.info.key, reason)
    this.ctx
      .env()
      .setBotStatus(
        botId,
        effective,
        shown.detail,
        shown.targetBotId,
        shown.info.sessionId ?? undefined,
        shown.current?.conversationId,
      )
  }

  /** Status of the chat lane from what it is doing (after the bot is resumed or given its screen back). */
  refreshStatus(botId: string): void {
    const main = this.lane(botId)
    this.setStatus(
      main,
      main.running ? 'working' : main.queue.length ? 'thinking' : 'idle',
      undefined,
      undefined,
      'refresh',
    )
  }

  /**
   * A system line in the conversation of `lane`'s running turn (without a lane: any running turn of the
   * bot), else in `fallbackConversationId` or the bot's direct chat.
   */
  systemLine(
    botId: string,
    event: SystemEventName,
    content: string,
    where: { lane?: LaneState; fallbackConversationId?: string; params?: SystemPayload['params'] } = {},
  ): void {
    const env = this.ctx.env()
    const { lane } = where
    const state = this.bot(botId)
    const current =
      (lane ?? this.lane(botId)).current ??
      (lane ? null : ([...state.lanes.values()].find((l) => l.current)?.current ?? null))
    const conversationId =
      current?.conversationId ?? where.fallbackConversationId ?? env.findDirectConversation(botId)?.id
    if (!conversationId) return
    env.appendMessage({
      conversationId,
      authorType: 'system',
      kind: 'system_event',
      content,
      payload: { type: 'system', event, botId, params: where.params ?? {} },
      turnId: current?.id ?? null,
    })
  }
}
