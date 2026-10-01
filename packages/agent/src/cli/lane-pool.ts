import { isBotLane, type LaneKey } from '../host/lanes'
import type { GuestCliBackend } from './backend'
import type {
  CliLaunch,
  CliLog,
  CliOneShot,
  CliOneShotResult,
  CliSessions,
  CliTurnIO,
  CliTurnResult,
} from './engine'
import { type CliTiming, DEFAULT_CLI_TIMING } from './process'

/** What a lane keeps alive between turns: an engine's process (and its session state). */
export interface LaneProcess {
  readonly alive: boolean
  close(force?: boolean): Promise<void>
}

export const laneKeyOf = (launch: Pick<CliLaunch, 'bot' | 'key'>): LaneKey => launch.key ?? launch.bot.id

/**
 * One process per active bot lane, closed after `idleTimeoutMs` without a turn; the lane's session id stays
 * stored (in the backend), so the next process resumes it. Engines implement the turn itself.
 */
export abstract class LaneSessions<P extends LaneProcess> implements CliSessions {
  private readonly lanes = new Map<LaneKey, { process: P; idleTimer: NodeJS.Timeout | null }>()

  constructor(
    protected readonly backend: GuestCliBackend,
    protected readonly log: CliLog = () => {},
    protected readonly timing: CliTiming = DEFAULT_CLI_TIMING,
  ) {}

  abstract runTurn(launch: CliLaunch, input: string, io: CliTurnIO): Promise<CliTurnResult>
  abstract oneShot(request: CliOneShot): Promise<CliOneShotResult>

  protected lane(key: LaneKey): P | undefined {
    return this.lanes.get(key)?.process
  }

  protected addLane(key: LaneKey, process: P): void {
    this.lanes.set(key, { process, idleTimer: null })
  }

  /** A turn starts on the lane: it stays open meanwhile. */
  protected laneBusy(key: LaneKey): void {
    const entry = this.lanes.get(key)
    if (entry?.idleTimer) clearTimeout(entry.idleTimer)
    if (entry) entry.idleTimer = null
  }

  /** The turn on `process` ended: the lane closes after `ms` without another one. */
  protected laneIdle(key: LaneKey, process: P, ms: number): void {
    const entry = this.lanes.get(key)
    if (entry?.process !== process || !process.alive) return
    entry.idleTimer = setTimeout(() => void this.close(key), ms)
    entry.idleTimer.unref?.()
  }

  /** Forgets `process` (it exited by itself). */
  protected dropLane(key: LaneKey, process: P): void {
    const entry = this.lanes.get(key)
    if (entry?.process !== process) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    this.lanes.delete(key)
  }

  async close(key: LaneKey, force = false): Promise<void> {
    const entry = this.lanes.get(key)
    if (!entry) return
    this.lanes.delete(key)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    await entry.process.close(force)
  }

  async closeBot(botId: string): Promise<void> {
    await Promise.all(
      this.activeLanes()
        .filter((k) => isBotLane(k, botId))
        .map((k) => this.close(k)),
    )
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.activeLanes().map((k) => this.close(k)))
  }

  async rotate(key: LaneKey): Promise<void> {
    this.backend.setSessionId(key, null)
    await this.close(key)
  }

  storedSessionId(key: LaneKey): string | null {
    return this.backend.getSessionId(key)
  }

  activeLanes(): LaneKey[] {
    return [...this.lanes.keys()]
  }
}
