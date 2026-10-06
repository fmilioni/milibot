import type { BotStatus } from '@milibot/shared'

import type { TurnOutcome, TurnRequest } from '../../environment'
import type { HostContext } from '../context'
import type { LaneInfo, LaneKey } from '../lanes'

/**
 * Why a lane's status was set, logged with each change (`daemon_logs` reads it back). Codes only: the
 * status's free `detail` (the activity text, a tool's arguments) never reaches the log.
 */
export type StatusReason =
  | 'queued'
  | 'turn_start'
  | 'turn_end'
  | 'llm'
  | 'reply'
  | 'tool'
  | 'out_of_turn_call'
  | 'wait'
  | 'pause'
  | 'paused_wait'
  | 'takeover'
  | 'stop'
  | 'refresh'
  | 'remove'
  | 'bot_removed'

/** Statuses a turn moves between at every step: a change among them is not logged, or every tool call would be. */
const phase = (status: BotStatus): 'idle' | 'paused' | 'busy' =>
  status === 'idle' || status === 'paused' ? status : 'busy'

/**
 * The daemon log's record of the bots' state: turns, lanes opened and closed, and bot and lane status changes
 * between idle, paused and busy. Each record carries `botId` and `botName`.
 */
export class StatusLog {
  private readonly lanes = new Map<LaneKey, BotStatus>()
  private readonly bots = new Map<string, BotStatus>()

  constructor(private readonly ctx: HostContext) {}

  laneOpened(info: LaneInfo): void {
    this.write('lane.open', info.botId, { lane: info.key, kind: info.kind })
  }

  laneClosed(info: LaneInfo, reason: StatusReason = 'remove'): void {
    this.lanes.delete(info.key)
    this.write('lane.close', info.botId, { lane: info.key, kind: info.kind, reason })
  }

  botRemoved(botId: string): void {
    this.bots.delete(botId)
    for (const key of this.lanes.keys())
      if (key === botId || key.startsWith(`${botId}:`)) this.lanes.delete(key)
  }

  laneStatus(info: LaneInfo, to: BotStatus, reason: StatusReason | undefined): void {
    const from = this.lanes.get(info.key) ?? 'idle'
    this.lanes.set(info.key, to)
    if (phase(from) === phase(to)) return
    this.write('lane.status', info.botId, { lane: info.key, from, to, reason: reason ?? 'step' })
  }

  botStatus(botId: string, to: BotStatus, lane: LaneKey, reason: StatusReason | undefined): void {
    const from = this.bots.get(botId) ?? 'idle'
    this.bots.set(botId, to)
    if (phase(from) === phase(to)) return
    this.write('bot.status', botId, { from, to, lane, reason: reason ?? 'step' })
  }

  turnStarted(turn: { id: string; botId: string; laneKey: LaneKey }, trigger: TurnRequest['trigger']): void {
    this.write('turn.start', turn.botId, { lane: turn.laneKey, turnId: turn.id, trigger })
  }

  turnEnded(
    turn: { id: string; botId: string; laneKey: LaneKey; startedAt: number },
    trigger: TurnRequest['trigger'],
    outcome: TurnOutcome,
  ): void {
    this.write('turn.end', turn.botId, {
      lane: turn.laneKey,
      turnId: turn.id,
      trigger,
      durationMs: this.ctx.env().now() - turn.startedAt,
      outcome: outcome === 'cancelled' ? 'aborted' : outcome,
    })
  }

  private write(message: string, botId: string, extra: Record<string, unknown>): void {
    const env = this.ctx.env()
    env.log('info', message, { botId, botName: env.getBot(botId)?.name ?? null, ...extra })
  }
}
