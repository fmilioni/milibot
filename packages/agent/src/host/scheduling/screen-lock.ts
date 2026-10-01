import { screenBusyReply } from '../../prompts/tool-replies'
import type { HostContext } from '../context'
import { laneInfo } from '../lanes'
import { type BotState, type LaneState, StoppedError, type TurnState } from '../state'

/**
 * The display and Chrome are shared by the bot's lanes: a lane holds them from its first screen tool call
 * until its turn ends.
 */
export class ScreenLock {
  constructor(private readonly ctx: HostContext) {}

  /**
   * Takes the screen for `lane`. Another lane waits (without its slot) up to `screenWaitSeconds`; returns the
   * error to give the bot when the screen stays busy.
   */
  async acquire(lane: LaneState, turn: TurnState, signal: AbortSignal, kind: string): Promise<string | null> {
    const env = this.ctx.env()
    const state = this.ctx.lanes.bot(lane.info.botId)
    const free = () => state.screen.holder === null || state.screen.holder === lane.info.key
    if (!free()) {
      const seconds = this.ctx.options.screenWaitSeconds
      const deadline = env.now() + Math.max(0, seconds) * 1000
      while (!free()) {
        const left = deadline - env.now()
        if (left <= 0) {
          const holder = state.screen.holder ? laneInfo(state.screen.holder).kind : null
          return screenBusyReply(holder === 'main' || holder === 'internal' ? holder : 'session', seconds)
        }
        await this.ctx.scheduler.detached(lane, turn, released(state, left, signal), kind)
        if (signal.aborted) throw new StoppedError()
      }
    }
    state.screen.holder = lane.info.key
    return null
  }

  release(lane: LaneState): void {
    const state = this.ctx.lanes.find(lane.info.botId)
    if (!state || state.screen.holder !== lane.info.key) return
    state.screen.holder = null
    for (const waiter of [...state.screen.waiters]) waiter()
  }
}

function released(state: BotState, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      state.screen.waiters = state.screen.waiters.filter((w) => w !== done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    signal.addEventListener('abort', done, { once: true })
    state.screen.waiters.push(done)
  })
}
