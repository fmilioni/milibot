import type { ApiClient, WorkspaceEvent } from '@milibot/shared'

import type { KeepAwakeState } from '../../../bridge/contract'
import type { WorkspaceEventSubscriber } from '../workspace-events'
import { BusyBots } from './busy-bots'

/** While the lock is held, statuses are read again this often, in case an event was lost. */
export const RESYNC_INTERVAL_MS = 60_000
/** A snapshot that takes longer counts as failed: its statuses are dropped rather than kept busy. */
export const SYNC_TIMEOUT_MS = 10_000
/** After a failed snapshot, the statuses are asked again this soon, while the socket stays open. */
export const SYNC_RETRY_MS = 15_000

/** Electron's `powerSaveBlocker`, narrowed to what the guard uses. */
interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

export interface KeepAwakeGuardDeps {
  feed: {
    readonly client: ApiClient | null
    subscribe(subscriber: WorkspaceEventSubscriber): void
  }
  settings: {
    readonly keepAwake: boolean
    onKeepAwake(listener: (keepAwake: boolean) => void): void
  }
  blocker: PowerBlocker
}

/**
 * Keeps the computer from sleeping (the screen may still turn off) while a bot of any workspace is
 * working: chat turns, work sessions and plans, routines and helpers all show in `bot.status`. Never
 * stuck: a workspace whose socket closes or whose runtime stops is forgotten, and if the app dies the
 * system drops the lock with the process.
 */
export class KeepAwakeGuard {
  private readonly bots = new BusyBots()
  /** Workspaces whose runtime reported `running` on a socket that is still open. */
  private readonly running = new Set<string>()
  private blockerId: number | null = null
  private resyncTimer: ReturnType<typeof setInterval> | null = null
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private current: KeepAwakeState = { active: false, busyBots: 0 }
  private readonly listeners = new Set<(state: KeepAwakeState) => void>()

  constructor(private readonly deps: KeepAwakeGuardDeps) {
    deps.feed.subscribe({
      event: (workspaceId, event) => this.handle(workspaceId, event),
      disconnected: (workspaceId) => this.forget(workspaceId),
      removed: (workspaceId) => this.forget(workspaceId),
    })
    deps.settings.onKeepAwake(() => this.update())
  }

  get state(): KeepAwakeState {
    return this.current
  }

  onChange(listener: (state: KeepAwakeState) => void): void {
    this.listeners.add(listener)
  }

  private handle(workspaceId: string, event: WorkspaceEvent): void {
    if (event.type === 'runtime.status') {
      if (event.payload.status === 'running') {
        this.running.add(workspaceId)
        void this.sync(workspaceId)
      } else this.forget(workspaceId)
      return
    }
    if (!this.running.has(workspaceId)) return
    this.bots.apply(workspaceId, event)
    this.update()
  }

  private forget(workspaceId: string): void {
    this.running.delete(workspaceId)
    this.cancelRetry(workspaceId)
    this.bots.clear(workspaceId)
    this.update()
  }

  private cancelRetry(workspaceId: string): void {
    const timer = this.retryTimers.get(workspaceId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.retryTimers.delete(workspaceId)
  }

  /** Statuses stored while the runtime was down may be stale, so only a running runtime is asked. */
  private async sync(workspaceId: string): Promise<void> {
    const client = this.deps.feed.client
    if (!client) return
    this.cancelRetry(workspaceId)
    const token = this.bots.beginSync(workspaceId)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('timed out')), SYNC_TIMEOUT_MS)
    try {
      const bots = await client.call('listBots', { params: { workspaceId }, signal: abort.signal })
      if (!this.running.has(workspaceId)) return
      this.bots.finishSync(workspaceId, token, bots)
      this.update()
    } catch (err) {
      console.warn('[keep-awake] bot statuses unavailable', err instanceof Error ? err.message : err)
      // Only this snapshot's failure counts; a newer one may already be out. The statuses are
      // dropped so a lost event cannot keep the lock, but the socket is still open: its events keep
      // being applied and the snapshot is asked again.
      if (this.bots.isPending(workspaceId, token) && this.running.has(workspaceId)) {
        this.bots.clear(workspaceId)
        this.update()
        this.retryTimers.set(
          workspaceId,
          setTimeout(() => {
            this.retryTimers.delete(workspaceId)
            if (this.running.has(workspaceId)) void this.sync(workspaceId)
          }, SYNC_RETRY_MS),
        )
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private update(): void {
    const busyBots = this.bots.count
    const active = this.deps.settings.keepAwake && busyBots > 0
    this.hold(active)
    if (active === this.current.active && busyBots === this.current.busyBots) return
    this.current = { active, busyBots }
    for (const listener of this.listeners) listener(this.current)
  }

  private hold(active: boolean): void {
    if (active && this.blockerId === null) {
      this.blockerId = this.deps.blocker.start('prevent-app-suspension')
      this.resyncTimer = setInterval(() => {
        for (const workspaceId of this.running) void this.sync(workspaceId)
      }, RESYNC_INTERVAL_MS)
      console.log('[keep-awake] keeping the computer awake')
    } else if (!active && this.blockerId !== null) {
      this.deps.blocker.stop(this.blockerId)
      this.blockerId = null
      if (this.resyncTimer) clearInterval(this.resyncTimer)
      this.resyncTimer = null
      console.log('[keep-awake] the computer may sleep again')
    }
  }
}
