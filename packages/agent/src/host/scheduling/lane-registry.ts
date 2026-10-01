import type { BotStatus, SystemEventName, SystemPayload } from '@milibot/shared'

import type { HostContext } from '../context'
import { busier, laneInfo, type LaneKey } from '../lanes'
import type { BotState, LaneState, TurnState } from '../state'

/** The bots' lanes and what the bot shows of them (its status, system lines in its chat). */
export class LaneRegistry {
  private readonly bots = new Map<string, BotState>()

  constructor(private readonly ctx: HostContext) {}

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
      lane = { info, queue: [], running: false, current: null, stopped: false, detached: 0, status: 'idle' }
      state.lanes.set(key, lane)
    }
    return lane
  }

  laneOf(botId: string, turn: TurnState | null): LaneState {
    return this.lane(turn?.laneKey ?? botId)
  }

  removeBot(botId: string): void {
    this.bots.delete(botId)
  }

  removeLane(lane: LaneState): void {
    const state = this.bots.get(lane.info.botId)
    if (state?.lanes.get(lane.info.key) === lane) state.lanes.delete(lane.info.key)
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

  setStatus(lane: LaneState, status: BotStatus, detail?: string, targetBotId?: string): void {
    const env = this.ctx.env()
    const botId = lane.info.botId
    const state = this.bot(botId)
    lane.status = status
    lane.detail = detail
    lane.targetBotId = targetBotId
    if (lane.info.kind === 'session' && lane.info.sessionId)
      env.workSessions.laneStatus(lane.info.sessionId, status, detail ?? null)
    const shown = this.shownLane(state, botId)
    const own = shown === lane
    const effective = state.userPaused || (state.paused && shown.status !== 'idle') ? 'paused' : shown.status
    if (state.status === effective && state.statusLane === shown.info.key && (!own || detail === undefined))
      return
    state.status = effective
    state.statusLane = shown.info.key
    env.setBotStatus(
      botId,
      effective,
      own ? detail : shown.detail,
      own ? targetBotId : shown.targetBotId,
      shown.info.sessionId ?? undefined,
      shown.current?.conversationId,
    )
  }

  /** Status of the chat lane from what it is doing (after the bot is resumed or given its screen back). */
  refreshStatus(botId: string): void {
    const main = this.lane(botId)
    this.setStatus(main, main.running ? 'working' : main.queue.length ? 'thinking' : 'idle')
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
