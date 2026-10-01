import {
  type LogFn,
  PREFERENCE_SETTING_KEYS,
  type SpendStatus,
  type SpendWarningPayload,
} from '@milibot/shared'

import { errorMessage } from '../../errors'
import { localDay } from '../../util/time'

const STATE_KEY = 'spend.state'

interface StoredState {
  day: string
  warned: boolean
  paused: boolean
  resumed: boolean
}

export interface SpendGuardDeps {
  now: () => number
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  /** Cost of the local day that contains `now`. */
  todayCost(now: number): number
  /** Posts the spend card (warning or pause) in the chat. */
  postCard(content: string, payload: SpendWarningPayload): void
  /** Holds (true) or releases (false) every bot's queue. */
  hold(held: boolean): void
  log?: LogFn
}

function spendCard(card: {
  spentUsd: number
  warnUsd: number | null
  limitUsd: number | null
  paused: boolean
}) {
  const content = card.paused
    ? `Bots paused: today's spend reached US$ ${card.limitUsd?.toFixed(2)}`
    : `Today's spend passed US$ ${card.warnUsd?.toFixed(2)}`
  const payload: SpendWarningPayload = {
    type: 'spend_warning',
    spentUsd: card.spentUsd,
    warnUsd: card.warnUsd ?? card.limitUsd ?? 0,
    limitUsd: card.limitUsd,
    paused: card.paused,
  }
  return { content, payload }
}

function nextLocalMidnight(at: number): number {
  const d = new Date(at)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

/**
 * Daily spend limits: a chat card once a day past the warning limit, and every bot held once today's cost
 * reaches the pause limit, until the next local day or until the user resumes them.
 */
export class SpendGuard {
  private timer: NodeJS.Timeout | null = null
  private held = false

  constructor(private readonly deps: SpendGuardDeps) {}

  private limits(): { warn: number | null; pause: number | null } {
    const get = this.deps.getSetting.bind(this.deps)
    return {
      warn: positive(get<unknown>(PREFERENCE_SETTING_KEYS.spendWarnUsd, null)),
      pause: positive(get<unknown>(PREFERENCE_SETTING_KEYS.spendPauseUsd, null)),
    }
  }

  private state(now: number): StoredState {
    const day = localDay(now)
    const stored = this.deps.getSetting<StoredState | null>(STATE_KEY, null)
    return stored && stored.day === day ? stored : { day, warned: false, paused: false, resumed: false }
  }

  private save(state: StoredState): void {
    this.deps.setSetting(STATE_KEY, state)
  }

  private setHeld(held: boolean): void {
    if (this.held === held) return
    this.held = held
    this.deps.hold(held)
  }

  /** Restores today's hold (runtime restart) and schedules the midnight release. */
  start(): void {
    this.check()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(now: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.check(), Math.max(1000, nextLocalMidnight(now) - now + 1000))
    this.timer.unref?.()
  }

  private notify(card: Parameters<typeof spendCard>[0]): void {
    const { content, payload } = spendCard(card)
    this.deps.postCard(content, payload)
  }

  /** After every LLM call: a failing check is logged, never thrown at the caller. */
  afterLlmCall(): void {
    try {
      this.check()
    } catch (err) {
      this.deps.log?.('warn', 'spend check failed', { err: errorMessage(err) })
    }
  }

  /** Runs after every LLM call (and at midnight). */
  check(): SpendStatus {
    const now = this.deps.now()
    const state = this.state(now)
    const spent = this.deps.todayCost(now)
    const { warn, pause } = this.limits()
    let changed = false
    if (warn !== null && spent >= warn && !state.warned) {
      state.warned = true
      changed = true
      if (!(pause !== null && spent >= pause && !state.resumed && !state.paused))
        this.notify({ spentUsd: spent, warnUsd: warn, limitUsd: pause, paused: false })
    }
    if (pause !== null && spent >= pause && !state.paused && !state.resumed) {
      state.paused = true
      state.warned = true
      changed = true
      this.notify({ spentUsd: spent, warnUsd: warn, limitUsd: pause, paused: true })
      this.deps.log?.('warn', 'bots held: daily spend limit reached', { spent, pause })
    }
    // A raised (or removed) limit lets the bots go again.
    if (state.paused && (pause === null || spent < pause)) {
      state.paused = false
      changed = true
    }
    if (changed) this.save(state)
    this.setHeld(state.paused)
    this.schedule(now)
    return { day: state.day, todayUsd: spent, ...pick(state) }
  }

  resume(): SpendStatus {
    const now = this.deps.now()
    const state = this.state(now)
    state.paused = false
    state.resumed = true
    this.save(state)
    this.setHeld(false)
    return this.status()
  }

  status(): SpendStatus {
    const now = this.deps.now()
    const state = this.state(now)
    return { day: state.day, todayUsd: this.deps.todayCost(now), ...pick(state) }
  }
}

function pick(state: StoredState): Pick<SpendStatus, 'warned' | 'paused' | 'resumed'> {
  return { warned: state.warned, paused: state.paused, resumed: state.resumed }
}
