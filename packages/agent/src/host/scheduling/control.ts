import type { BotControlAction, BotControlOptions } from '@milibot/shared'

import type { ScreenState } from '../../environment'
import type { HostContext } from '../context'
import { type BotState, type LaneState, StoppedError } from '../state'

/** What the user does to a bot: pause, take over its screen, give it back, stop its work. */
export class BotControl {
  constructor(private readonly ctx: HostContext) {}

  /** Bots the user paused before the runtime restarted stay paused. */
  restore(): void {
    const env = this.ctx.env()
    for (const bot of env.listBots()) {
      const paused = env.hostState.paused(bot.id)
      if (paused) {
        const state = this.ctx.lanes.bot(bot.id)
        state.paused = true
        state.userPaused = true
        state.status = 'paused'
      }
      const status = paused ? 'paused' : 'idle'
      if (bot.status !== status) env.setBotStatus(bot.id, status)
    }
  }

  screenState(botId: string): ScreenState {
    const state = this.ctx.lanes.bot(botId)
    const lanes = [...state.lanes.values()]
    return {
      paused: state.paused,
      control: state.takenOver ? 'user' : lanes.some((l) => l.running) ? 'bot' : 'idle',
      busy: lanes.some((l) => l.running || l.queue.length > 0),
    }
  }

  private stopTargets(state: BotState, options: BotControlOptions): LaneState[] {
    const lanes = [...state.lanes.values()]
    if (options.sessionId) return lanes.filter((l) => l.info.sessionId === options.sessionId)
    if (options.scope === 'chat')
      return lanes.filter((l) => l.info.kind !== 'session' && l.info.sessionId === null)
    return lanes
  }

  control(botId: string, action: BotControlAction, options: BotControlOptions = {}): ScreenState {
    const before = this.screenState(botId)
    this.apply(botId, action, options)
    const after = this.screenState(botId)
    if (after.control !== before.control || after.paused !== before.paused || after.busy !== before.busy)
      this.ctx.env().emitScreen(botId, after)
    return after
  }

  private apply(botId: string, action: BotControlAction, options: BotControlOptions): void {
    const env = this.ctx.env()
    const { lanes, scheduler } = this.ctx
    const state = lanes.bot(botId)
    const main = lanes.lane(botId)
    const name = env.getBot(botId)?.name ?? botId
    switch (action) {
      case 'pause':
        state.paused = true
        state.userPaused = true
        env.hostState.setPaused(botId, true)
        lanes.setStatus(main, 'paused', undefined, undefined, 'pause')
        break
      case 'resume':
        state.paused = false
        state.userPaused = false
        state.takenOver = false
        env.hostState.setPaused(botId, false)
        lanes.wake(botId)
        lanes.refreshStatus(botId)
        scheduler.pump()
        break
      case 'takeover':
        if (!state.takenOver)
          lanes.systemLine(botId, 'user_took_control', `You took control of ${name}'s screen`)
        state.paused = true
        state.takenOver = true
        lanes.setStatus(
          main,
          [...state.lanes.values()].some((l) => l.running) ? 'paused' : 'idle',
          undefined,
          undefined,
          'takeover',
        )
        break
      case 'release':
        if (state.takenOver) {
          state.needsScreenshot = true
          state.pendingNote = true
          lanes.systemLine(botId, 'user_released_control', `You gave the screen back to ${name}`)
        }
        state.paused = state.userPaused
        state.takenOver = false
        lanes.wake(botId)
        lanes.refreshStatus(botId)
        scheduler.pump()
        break
      case 'stop': {
        state.paused = state.userPaused
        state.takenOver = false
        const targets = this.stopTargets(state, options)
        if (targets.includes(main)) this.ctx.otherWork.dropBot(botId)
        for (const lane of targets) {
          const hadWork = lane.running || lane.queue.length > 0
          const queuedIn = lane.queue[0]?.conversationId
          scheduler.abortLane(lane, true)
          if (hadWork && lane.info.kind !== 'subagent')
            lanes.systemLine(botId, 'turn_stopped', `${name} stopped`, {
              lane,
              fallbackConversationId: queuedIn,
            })
          if (!lane.running) lanes.setStatus(lane, 'idle', undefined, undefined, 'stop')
        }
        lanes.wake(botId)
        break
      }
    }
  }

  /** Waits while the bot is paused (by the user or while the user has its screen). */
  async waitUntilRunnable(lane: LaneState, signal: AbortSignal): Promise<void> {
    const state = this.ctx.lanes.bot(lane.info.botId)
    while (state.paused) {
      if (signal.aborted) throw new StoppedError()
      this.ctx.lanes.setStatus(lane, 'paused', undefined, undefined, 'paused_wait')
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve()
        signal.addEventListener('abort', onAbort, { once: true })
        state.waiters.push(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
    if (signal.aborted) throw new StoppedError()
  }
}
