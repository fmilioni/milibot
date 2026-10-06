import type { AgentHost, NewAgentMessage, TurnOutcome } from '@milibot/agent'
import {
  type LogFn,
  type Message,
  nextRunAfter,
  type Routine,
  ROUTINE_LIMITS,
  type RoutineCatchUp,
  type routineEndpoints,
  type RoutineStatus,
  type WorkspaceEvent,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { WorkspaceStore } from '../workspace-store'
import { describeScheduleEn, formatLocal } from './format'
import { RoutineStore } from './store'
import type { VmGate } from './vm-gate'

/** A run later than this after its time was missed (app, computer or VM off, or the computer asleep). */
const MISSED_AFTER_MS = 2 * 60_000
/** The scheduler wakes at least this often (clock changes, waiting runs, sleep). */
const MAX_SLEEP_MS = 60_000

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface RoutineServiceDeps {
  db: Db
  store: WorkspaceStore
  host: Pick<AgentHost, 'enqueueTurn'>
  emit: (event: WorkspaceEvent) => void
  appendMessage: (message: NewAgentMessage) => Message
  now: () => number
  catchUp: () => RoutineCatchUp
  /** Bots are held by the daily spend limit. */
  held: () => boolean
  vmGate: () => VmGate
  bootVm: () => void
  timers?: Timers
  log?: LogFn
}

interface RunOptions {
  /** Its time passed while the runtime could not run it. */
  missed: boolean
  manual: boolean
  scheduledAt: number | null
}

type RoutinePatch = {
  name?: string | undefined
  prompt?: string | undefined
  cron?: string | undefined
  enabled?: boolean | undefined
}

/**
 * Routines: CRUD and the scheduler (cron in local time, catch-up of missed runs, VM and spend-limit gates).
 * A run posts the `routine_run` card ("Routine: <name>", with the instructions the bot reads as a user
 * message) in the bot's DM and queues a `routine` turn; the host's queue enforces one turn per bot and
 * max_parallel.
 */
export class RoutineService {
  private readonly rows: RoutineStore
  private timer: unknown = null
  private stopped = true
  /** Routines with a run queued/in progress (`running`) or held (`waiting`, with its due time). */
  private readonly running = new Set<string>()
  private readonly waiting = new Map<string, number | null>()
  private readonly timers: Timers

  constructor(private readonly deps: RoutineServiceDeps) {
    this.rows = new RoutineStore(deps.db, deps.now)
    this.timers = deps.timers ?? realTimers
  }

  start(): void {
    this.stopped = false
    const now = this.deps.now()
    this.rows.markInterrupted()
    for (const routine of this.rows.list()) {
      if (routine.enabled && routine.lastStatus === 'waiting') this.waiting.set(routine.id, null)
      if (routine.enabled && routine.nextRunAt === null)
        this.rows.setNext(routine.id, nextAfter(routine.cron, now))
    }
    this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  /** Runs due routines and held runs that can go now; re-arms the timer. */
  tick(): void {
    if (this.stopped) return
    const now = this.deps.now()
    for (const routine of this.rows.due(now)) {
      const scheduledAt = routine.nextRunAt as number
      this.rows.setNext(routine.id, nextAfter(routine.cron, now))
      try {
        this.trigger(this.get(routine.id), {
          missed: now - scheduledAt > MISSED_AFTER_MS,
          manual: false,
          scheduledAt,
        })
      } catch (err) {
        this.deps.log?.('warn', 'routine run failed to start', {
          routineId: routine.id,
          err: errorMessage(err),
        })
      }
    }
    for (const id of [...this.waiting.keys()]) this.resumeWaiting(id)
    this.arm()
  }

  private arm(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    if (this.stopped) return
    const next = this.rows.nextDue()
    const delay = next === null ? MAX_SLEEP_MS : Math.min(Math.max(next - this.deps.now(), 0), MAX_SLEEP_MS)
    this.timer = this.timers.set(() => {
      this.timer = null
      this.tick()
    }, delay)
  }

  private trigger(routine: Routine, options: RunOptions): void {
    if (this.running.has(routine.id) || this.waiting.has(routine.id)) {
      this.deps.log?.('info', 'routine still running: this occurrence is skipped', { routineId: routine.id })
      return
    }
    const catchUp = this.deps.catchUp()
    if (options.missed && !options.manual && catchUp === 'skip') {
      this.setStatus(routine.id, 'skipped')
      return
    }
    const gate = this.deps.vmGate()
    if (options.manual) {
      if (this.deps.held()) {
        throw new DaemonError('conflict', 'Bots are paused by the daily spend limit', {
          reason: 'spend_paused',
        })
      }
      if (gate !== 'run') this.deps.bootVm()
      this.startRun(routine, options)
      return
    }
    if (this.deps.held() || gate === 'wait') {
      if (catchUp === 'skip') {
        this.setStatus(routine.id, 'skipped')
        return
      }
      this.waiting.set(routine.id, options.scheduledAt)
      this.setStatus(routine.id, 'waiting')
      return
    }
    if (gate === 'boot') this.deps.bootVm()
    this.startRun(routine, options)
  }

  private resumeWaiting(id: string): void {
    const routine = this.rows.find(id)
    if (!routine || !routine.enabled) {
      this.waiting.delete(id)
      if (routine?.lastStatus === 'waiting') this.setStatus(id, null)
      return
    }
    if (this.deps.held()) return
    const gate = this.deps.vmGate()
    if (gate === 'wait') return
    const scheduledAt = this.waiting.get(id) ?? null
    this.waiting.delete(id)
    if (gate === 'boot') this.deps.bootVm()
    this.startRun(routine, { missed: true, manual: false, scheduledAt })
  }

  private startRun(routine: Routine, options: RunOptions): void {
    const bot = this.deps.store.bots.find(routine.botId)
    const dm = bot ? this.deps.store.conversations.findDirect(bot.id) : null
    if (!bot || !dm) {
      this.setStatus(routine.id, 'error')
      this.deps.log?.('warn', 'routine has no bot or DM', { routineId: routine.id })
      return
    }
    this.deps.appendMessage({
      conversationId: dm.id,
      authorType: 'system',
      kind: 'card',
      content: this.instructions(routine, options),
      payload: {
        type: 'routine_run',
        routineId: routine.id,
        botId: bot.id,
        name: routine.name,
        prompt: routine.prompt,
        late: options.missed,
        manual: options.manual,
      },
    })
    this.running.add(routine.id)
    this.rows.markRunning(routine.id)
    this.emit(routine.id)
    this.deps.host.enqueueTurn({
      botId: bot.id,
      conversationId: dm.id,
      trigger: 'routine',
      routineId: routine.id,
      onFinished: (outcome) => this.finished(routine.id, outcome),
    })
  }

  /** What the bot reads for this run; it stays in the conversation, so later turns still see it. */
  private instructions(routine: Routine, options: RunOptions): string {
    const started = options.manual ? 'the user started it with "Run now"' : 'its schedule started it'
    const lines = [
      `[Milibot] Routine "${routine.name}" (${describeScheduleEn(routine.cron)}) ran at ${formatLocal(this.deps.now())}: ${started}; it is not a new message from the user. Do the task below and report the result here briefly.`,
    ]
    if (options.missed && options.scheduledAt !== null) {
      lines.push(
        `It was due at ${formatLocal(options.scheduledAt)} but could not run then (the computer or the VM was off); it runs late now.`,
      )
    }
    lines.push('', 'Routine instructions:', routine.prompt)
    return lines.join('\n')
  }

  private finished(id: string, outcome: TurnOutcome): void {
    this.running.delete(id)
    if (!this.rows.find(id)) return
    this.setStatus(id, outcome === 'done' ? 'ok' : outcome)
  }

  private setStatus(id: string, status: RoutineStatus | null): void {
    this.rows.setStatus(id, status)
    this.emit(id)
  }

  private emit(id: string): Routine {
    const routine = this.get(id)
    this.deps.emit({ type: 'routine.updated', payload: { routine } })
    return routine
  }

  list(botId?: string): Routine[] {
    return this.rows.list(botId)
  }

  get(id: string): Routine {
    const routine = this.rows.find(id)
    if (!routine) throw notFound('routine', id)
    return routine
  }

  create(
    botId: string,
    input: { name: string; prompt: string; cron: string; enabled?: boolean | undefined },
  ): Routine {
    this.deps.store.bots.get(botId)
    if (this.rows.countForBot(botId) >= ROUTINE_LIMITS.perBot) {
      throw new DaemonError('conflict', `A bot can have at most ${ROUTINE_LIMITS.perBot} routines`)
    }
    const enabled = input.enabled ?? true
    const id = this.rows.insert(botId, {
      name: input.name,
      prompt: input.prompt,
      cron: input.cron,
      enabled,
      nextRunAt: enabled ? nextAfter(input.cron, this.deps.now()) : null,
    })
    const routine = this.emit(id)
    this.arm()
    return routine
  }

  update(id: string, patch: RoutinePatch): Routine {
    const current = this.get(id)
    const cron = patch.cron ?? current.cron
    const enabled = patch.enabled ?? current.enabled
    const reschedule = patch.cron !== undefined || patch.enabled !== undefined
    this.rows.update(id, {
      name: patch.name ?? current.name,
      prompt: patch.prompt ?? current.prompt,
      cron,
      enabled,
      nextRunAt: reschedule ? (enabled ? nextAfter(cron, this.deps.now()) : null) : current.nextRunAt,
    })
    if (!enabled && this.waiting.delete(id)) this.setStatus(id, null)
    const routine = this.emit(id)
    this.arm()
    return routine
  }

  delete(id: string): Routine {
    const routine = this.get(id)
    this.rows.delete(id)
    this.waiting.delete(id)
    this.deps.emit({ type: 'routine.deleted', payload: { routineId: id, botId: routine.botId } })
    this.arm()
    return routine
  }

  /** A deleted bot's routines go with it. */
  botDeleted(botId: string): void {
    for (const routine of this.rows.list(botId)) this.delete(routine.id)
  }

  runNow(id: string): Routine {
    const routine = this.get(id)
    if (this.running.has(id)) throw new DaemonError('conflict', 'This routine is already running')
    this.waiting.delete(id)
    this.trigger(routine, { missed: false, manual: true, scheduledAt: null })
    return this.get(id)
  }

  /** Names of the routines among `ids` with their bots, for links in text. */
  names(ids: readonly string[]): Array<{ id: string; name: string; botId: string }> {
    return this.rows.names(ids)
  }

  handlers(): EndpointHandlers<keyof typeof routineEndpoints> {
    return {
      listRoutines: ({ query }) => this.list(query.botId),
      createRoutine: ({ params, body }) => this.create(params.botId, body),
      updateRoutine: ({ params, body }) => this.update(params.routineId, body),
      deleteRoutine: ({ params }) => {
        this.delete(params.routineId)
        return { ok: true as const }
      },
      runRoutine: ({ params }) => this.runNow(params.routineId),
    }
  }
}

function nextAfter(cron: string, at: number): number | null {
  try {
    return nextRunAfter(cron, at)
  } catch {
    return null
  }
}
