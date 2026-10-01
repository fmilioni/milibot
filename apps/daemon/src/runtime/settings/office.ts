import {
  type GuestOfficeStatus,
  LEGACY_OFFICE_INSTALL_MB,
  type LogFn,
  type officeEndpoints,
  type OfficeStatus,
  type WorkspaceEvent,
} from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { LegacyOfficeAccess } from '../files'
import { onVmTransition, type VmController } from '../vm'

/** Last state seen in the VM (shown while it is off: a reset or system update brings it back as missing). */
const INSTALLED_KEY = 'office.installed'
const POLL_MS = 1000
const MAX_POLL_MS = 15_000

export interface OfficeServiceDeps {
  vm: Pick<VmController, 'status' | 'runningGuest' | 'subscribe'>
  /** The `legacyOffice` preference. */
  enabled: () => boolean
  getSetting: <T>(key: string, fallback: T) => T
  setSetting: (key: string, value: unknown) => void
  emit: (event: WorkspaceEvent) => void
  pollMs?: number
  log?: LogFn
}

const busy = (g: GuestOfficeStatus | null) => g?.state === 'installing' || g?.state === 'removing'

/**
 * Keeps LibreOffice in the workspace VM in line with the preference: installs it when on (every time the VM
 * comes up without it, e.g. after a reset), removes it when off. The guest runs the apt work in the
 * background; this polls its progress and emits `office.status`.
 */
export class OfficeService {
  private guest: GuestOfficeStatus | null = null
  private unreachable: string | null = null
  private syncing: Promise<void> | null = null
  private again = false
  private timer: NodeJS.Timeout | null = null
  private pollDelay: number
  private unsubscribe: (() => void) | null = null
  private stopped = false
  private lastEmitted = ''
  private readyListeners: Array<() => void> = []

  constructor(private readonly deps: OfficeServiceDeps) {
    this.pollDelay = deps.pollMs ?? POLL_MS
  }

  start(): void {
    this.unsubscribe = onVmTransition(this.deps.vm, {
      up: () => void this.sync(),
      down: () => {
        this.guest = null
        this.unreachable = null
        this.clearTimer()
        this.changed()
      },
    })
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.clearTimer()
  }

  /** LibreOffice just became usable in the VM. */
  onReady(listener: () => void): void {
    this.readyListeners.push(listener)
  }

  status(): OfficeStatus {
    const enabled = this.deps.enabled()
    const base = { enabled, phase: null, progress: null, error: null, installMb: LEGACY_OFFICE_INSTALL_MB }
    const running = this.deps.vm.status().state === 'running'
    const g = running ? this.guest : null
    if (!g) {
      if (running && this.unreachable) return { ...base, state: 'error', error: this.unreachable }
      if (!enabled) return { ...base, state: 'off' }
      if (this.deps.getSetting<boolean>(INSTALLED_KEY, false)) return { ...base, state: 'installed' }
      return running ? { ...base, state: 'installing' } : { ...base, state: 'waiting_vm' }
    }
    if (busy(g)) {
      return {
        ...base,
        state: g.state === 'installing' ? 'installing' : 'removing',
        phase: g.phase,
        progress: g.progress,
      }
    }
    if (g.state === 'error' && (g.failed === 'install') === enabled)
      return { ...base, state: 'error', error: g.error }
    if (enabled) return g.installed ? { ...base, state: 'installed' } : { ...base, state: 'installing' }
    return g.installed
      ? { ...base, state: 'removing', phase: 'removing', progress: 0 }
      : { ...base, state: 'off' }
  }

  /** What `file_read` and the knowledge base need to know. */
  access(): LegacyOfficeAccess {
    const status = this.status()
    return {
      enabled: status.enabled,
      installing: status.enabled && (status.state === 'installing' || status.state === 'waiting_vm'),
      progress: status.progress,
    }
  }

  /** Asks the VM for what the preference wants (install or remove); a no-op with the VM off. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true
      return this.syncing
    }
    this.syncing = (async () => {
      do {
        this.again = false
        await this.syncOnce()
      } while (this.again && !this.stopped)
    })()
      .catch((err: unknown) => this.deps.log?.('warn', 'office sync failed', { err: errorMessage(err) }))
      .finally(() => {
        this.syncing = null
      })
    return this.syncing
  }

  handlers(): EndpointHandlers<keyof typeof officeEndpoints> {
    return {
      getOfficeStatus: () => this.status(),
      retryOffice: async () => {
        await this.sync()
        return this.status()
      },
    }
  }

  private async syncOnce(): Promise<void> {
    if (this.stopped) return
    if (this.deps.vm.status().state !== 'running') {
      this.guest = null
      this.changed()
      return
    }
    const guest = this.deps.vm.runningGuest()
    try {
      let g = await guest.officeStatus()
      const enabled = this.deps.enabled()
      // The guest queues requests and the last one wins, so a toggle during a run is sent right away.
      const wantsInstall = enabled && (g.state === 'removing' || (!busy(g) && !g.installed))
      const wantsRemove = !enabled && (g.state === 'installing' || (!busy(g) && g.installed))
      if (wantsInstall) g = await guest.officeInstall()
      else if (wantsRemove) g = await guest.officeRemove()
      this.unreachable = null
      this.apply(g)
    } catch (err) {
      this.unreachable = `Could not reach the VM: ${errorMessage(err)}`
      this.deps.log?.('warn', 'office status unavailable', { err: errorMessage(err) })
      this.changed()
    }
  }

  private apply(g: GuestOfficeStatus): void {
    const wasReady = this.guest?.installed === true && !busy(this.guest)
    this.guest = g
    if (!busy(g)) this.deps.setSetting(INSTALLED_KEY, g.installed)
    this.changed()
    if (busy(g)) this.schedulePoll()
    else this.pollDelay = this.deps.pollMs ?? POLL_MS
    if (!wasReady && g.installed && !busy(g)) {
      if (g.state === 'installed') this.deps.log?.('info', 'LibreOffice ready in the VM')
      for (const listener of this.readyListeners) listener()
    }
  }

  private schedulePoll(): void {
    this.clearTimer()
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped || this.deps.vm.status().state !== 'running') return
      this.deps.vm
        .runningGuest()
        .officeStatus()
        .then((g) => {
          this.unreachable = null
          this.apply(g)
        })
        .catch(() => {
          // The guest agent may be restarting; keep polling, a little slower each time.
          this.pollDelay = Math.min(MAX_POLL_MS, this.pollDelay * 2)
          this.schedulePoll()
        })
    }, this.pollDelay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private changed(): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    this.deps.emit({ type: 'office.status', payload: { status } })
  }
}
