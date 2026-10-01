import {
  type LogFn,
  VM_SETTING_KEYS,
  type VmConfig,
  type VmDetails,
  type VmDiskKind,
  type VmSystemUpdate,
  type VmTask,
  type VmTaskKind,
} from '@milibot/shared'

import { DaemonError } from '../../errors'
import { sleep } from '../../util/sleep'
import { VmCliError } from '../../vm-cli'
import type { SettingsStore } from '../settings'
import type { VmController } from './controller'

export interface VmAdminDeps {
  vm: VmController
  /** Configured CPUs/memory (settings) — the VM config follows them. */
  desired: () => { cpus: number; memGb: number }
  saveDesired: (config: { cpus?: number; memGb?: number }) => void
  /** Bots with a turn running or queued. */
  workingBots: () => number
  /** Resolves when no bot has work (restart "when idle"). */
  idle: () => Promise<void>
  now: () => number
  /** Announces progress (the UI refetches the details on `vm.status`). */
  changed: () => void
  /** Revision of the newest golden image on disk (null: missing) and the one this app version builds. */
  goldenRevisions: () => { available: number | null; latest: number }
  /** Pending system update, kept across runtime restarts (setting `vm.system_update`). */
  systemUpdate: {
    load: () => SystemUpdateRequest | null
    save: (request: SystemUpdateRequest | null) => void
  }
  /** How often a system update waiting for the new golden image checks for it (default 5 s). */
  goldenPollMs?: number
  log?: LogFn
}

export interface SystemUpdateRequest {
  whenIdle: boolean
  requestedAt: number
}

const SYSTEM_UPDATE_KEY = 'vm.system_update'

/** The VM size the user chose; a missing or invalid value falls back to `fallback`. */
export function readVmConfig(get: <T>(key: string, fallback: T) => T, fallback: VmConfig): VmConfig {
  const int = (key: keyof VmConfig) => {
    const value = get<unknown>(VM_SETTING_KEYS[key], null)
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback[key]
  }
  return { cpus: int('cpus'), memGb: int('memGb'), dataGb: int('dataGb'), systemGb: int('systemGb') }
}

function systemUpdateRequest(value: unknown): SystemUpdateRequest | null {
  if (!value || typeof value !== 'object') return null
  const { whenIdle, requestedAt } = value as Record<string, unknown>
  return typeof whenIdle === 'boolean' && typeof requestedAt === 'number' ? { whenIdle, requestedAt } : null
}

/** What `VmAdmin` keeps in the workspace settings: the chosen size and a pending system update. */
export function vmAdminSettings(
  settings: Pick<SettingsStore, 'get' | 'set' | 'setMany'>,
  vm: Pick<VmController, 'info'>,
): Pick<VmAdminDeps, 'desired' | 'saveDesired' | 'systemUpdate'> {
  return {
    desired: () => {
      const { cpus, memGb } = readVmConfig((key, fallback) => settings.get(key, fallback), vm.info().config)
      return { cpus, memGb }
    },
    saveDesired: (config) => settings.setMany(VM_SETTING_KEYS, config),
    systemUpdate: {
      load: () => systemUpdateRequest(settings.get<unknown>(SYSTEM_UPDATE_KEY, null)),
      save: (request) => settings.set(SYSTEM_UPDATE_KEY, request),
    },
  }
}

type AbortReason = 'cancelled' | 'stopping' | 'current'

class UpdateAborted extends Error {
  constructor(readonly reason: AbortReason) {
    super(`system update ${reason}`)
  }
}

interface PendingUpdate extends SystemUpdateRequest {
  status: VmSystemUpdate['status']
  wait: AbortController
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error)
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Settings-screen operations on the workspace VM. Anything that needs the VM stopped (disk growth,
 * restore points) stops it, runs, and boots it again if it was running; progress is the `task`, one
 * at a time. A system update waits (golden image, idle bots, the current task) without being the
 * task, so other operations keep working meanwhile.
 */
export class VmAdmin {
  private task: VmTask | null = null
  private running: Promise<void> | null = null
  private pending: PendingUpdate | null = null
  private waiting: Promise<void> | null = null

  constructor(private readonly deps: VmAdminDeps) {}

  async details(): Promise<VmDetails> {
    const { vm } = this.deps
    const info = vm.info()
    const runtime = await vm.details().catch((err: unknown) => {
      this.deps.log?.('warn', 'vm details unavailable', { err: (err as Error).message })
      return null
    })
    const desired = this.deps.desired()
    const running = info.state === 'running' || info.state === 'starting' ? (runtime?.running ?? null) : null
    const pending = this.pending
    return {
      vm: info,
      running,
      startedAt: running ? (runtime?.startedAt ?? null) : null,
      pendingRestart: running !== null && (running.cpus !== desired.cpus || running.memGb !== desired.memGb),
      disks: runtime?.disks ?? { system: null, data: null },
      snapshots: runtime?.snapshots ?? [],
      workingBots: this.deps.workingBots(),
      task: this.task,
      systemUpdate: pending
        ? { status: pending.status, whenIdle: pending.whenIdle, requestedAt: pending.requestedAt }
        : null,
    }
  }

  async updateResources(config: { cpus?: number; memGb?: number }): Promise<VmDetails> {
    this.deps.saveDesired(config)
    await this.deps.vm.resize(config)
    return this.details()
  }

  private busy(): boolean {
    const status = this.task?.status
    return status === 'running' || status === 'waiting_idle'
  }

  /** Runs `work` in the background as the current task; one task at a time. */
  private launch(kind: VmTaskKind, work: (setStatus: (s: VmTask['status']) => void) => Promise<void>): void {
    if (this.busy()) throw new DaemonError('conflict', 'Another VM operation is in progress')
    this.task = { kind, status: 'running', error: null, startedAt: this.deps.now(), finishedAt: null }
    const setStatus = (status: VmTask['status']) => {
      if (this.task) this.task = { ...this.task, status }
      this.deps.changed()
    }
    this.running = work(setStatus)
      .then(() => {
        this.task = { ...(this.task as VmTask), status: 'done', finishedAt: this.deps.now() }
      })
      .catch((err: unknown) => {
        const message = err instanceof VmCliError ? `${err.code}: ${err.message}` : (err as Error).message
        this.deps.log?.('error', `vm ${kind} failed`, { err: message })
        this.task = {
          ...(this.task as VmTask),
          status: 'error',
          error: message,
          finishedAt: this.deps.now(),
        }
      })
      .finally(() => {
        this.running = null
        this.deps.changed()
      })
    this.deps.changed()
  }

  /** Stops the VM (if running), runs `op`, and boots it again when it was running. */
  private async whileStopped(op: () => Promise<void>): Promise<void> {
    const { vm } = this.deps
    const wasRunning = vm.processRunning() || vm.info().state === 'running' || vm.info().state === 'starting'
    if (wasRunning) await vm.stop()
    try {
      await op()
    } finally {
      if (wasRunning) await vm.start()
    }
  }

  restart(whenIdle: boolean): Promise<VmDetails> {
    this.launch('restart', async (setStatus) => {
      if (whenIdle && this.deps.workingBots() > 0) {
        setStatus('waiting_idle')
        await this.deps.idle()
        setStatus('running')
      }
      await this.deps.vm.stop()
      await this.deps.vm.start()
    })
    return this.details()
  }

  /**
   * System reset: a new system disk from the newest golden image (the data disk is kept). When
   * that is the revision a pending system update waits for, the update has nothing left to do.
   */
  reset(): Promise<VmDetails> {
    this.launch('reset', async () => {
      await this.deps.vm.reset()
      if (this.systemCurrent()) this.pending?.wait.abort(new UpdateAborted('current'))
    })
    return this.details()
  }

  /**
   * Moves the system disk to the golden image this app version builds, keeping the data disk. Waits
   * for that image (built by the supervisor), with `whenIdle` for the bots to finish their work, and
   * for another VM operation to end; a stopped VM stays stopped.
   */
  updateSystem(whenIdle: boolean): Promise<VmDetails> {
    const system = this.deps.vm.info().system
    if (!system) throw new DaemonError('conflict', 'The workspace VM has not been created yet')
    if (this.systemCurrent())
      throw new DaemonError('conflict', 'The VM system is already up to date', { reason: 'up_to_date' })
    if (this.pending || (this.task?.kind === 'update_system' && this.task.status === 'running'))
      throw new DaemonError('conflict', 'A system update is already in progress')
    const request = { whenIdle, requestedAt: this.deps.now() }
    this.deps.systemUpdate.save(request)
    this.queueSystemUpdate(request)
    return this.details()
  }

  /** Cancels a system update that is still waiting; once the system is being replaced it runs to the end. */
  async cancelSystemUpdate(): Promise<VmDetails> {
    if (!this.pending) throw new DaemonError('conflict', 'No system update is waiting')
    this.pending.wait.abort(new UpdateAborted('cancelled'))
    await this.waiting
    return this.details()
  }

  /** Resumes a system update requested before the runtime restarted. */
  resumeSystemUpdate(): void {
    const request = this.deps.systemUpdate.load()
    if (!request || this.pending) return
    if (this.systemCurrent() !== false) {
      this.deps.systemUpdate.save(null)
      return
    }
    this.deps.log?.('info', 'resuming vm system update', { whenIdle: request.whenIdle })
    this.queueSystemUpdate(request)
  }

  /** Runtime shutdown: stops waiting, keeping the request for the next runtime. */
  close(): void {
    this.pending?.wait.abort(new UpdateAborted('stopping'))
  }

  private goldenReady(): boolean {
    const { available, latest } = this.deps.goldenRevisions()
    return available !== null && available >= latest
  }

  /** null: the VM has not been created. */
  private systemCurrent(): boolean | null {
    const system = this.deps.vm.info().system
    return system ? system.revision >= system.latestRevision : null
  }

  private queueSystemUpdate(request: SystemUpdateRequest): void {
    const pending: PendingUpdate = { ...request, status: 'waiting_golden', wait: new AbortController() }
    this.pending = pending
    this.waiting = this.waitAndRun(pending).finally(() => {
      this.waiting = null
    })
  }

  private async waitAndRun(pending: PendingUpdate): Promise<void> {
    const { signal } = pending.wait
    const setStatus = (status: PendingUpdate['status']) => {
      if (pending.status === status) return
      pending.status = status
      this.deps.changed()
    }
    // Once the bots went idle the update proceeds, unless another operation made it wait again.
    let idleSeen = false
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason as Error
        if (this.systemCurrent() !== false) throw new UpdateAborted('current')
        if (!this.goldenReady()) {
          setStatus('waiting_golden')
          await sleep(this.deps.goldenPollMs ?? 5000, signal)
        } else if (pending.whenIdle && !idleSeen && this.deps.workingBots() > 0) {
          setStatus('waiting_idle')
          await abortable(this.deps.idle(), signal)
          idleSeen = true
        } else if (this.busy() && this.running) {
          setStatus('waiting_task')
          await abortable(this.running, signal)
          idleSeen = false
        } else {
          break
        }
      }
    } catch (err) {
      this.pending = null
      const reason = err instanceof UpdateAborted ? err.reason : null
      if (reason !== 'stopping') this.deps.systemUpdate.save(null)
      if (reason === null) this.deps.log?.('error', 'vm system update wait failed', { err: String(err) })
      else if (reason === 'current') this.deps.log?.('info', 'vm system already current; update dropped')
      this.deps.changed()
      return
    }
    this.pending = null
    this.launch('update_system', async () => {
      const { vm } = this.deps
      try {
        if (vm.info().state === 'starting') await vm.start().catch(() => undefined)
        const wasRunning = vm.processRunning() || vm.info().state === 'running'
        await vm.reset({ boot: wasRunning })
      } finally {
        this.deps.systemUpdate.save(null)
      }
    })
  }

  async growDisk(disk: VmDiskKind, sizeGb: number): Promise<VmDetails> {
    const current = (await this.details()).disks[disk]
    if (!current) throw new DaemonError('conflict', 'The workspace VM has not been created yet')
    if (sizeGb * 1024 ** 3 <= current.virtualBytes)
      throw new DaemonError('validation_failed', 'Disks can only grow')
    this.launch('grow_disk', () => this.whileStopped(() => this.deps.vm.growDisk(disk, sizeGb)))
    return this.details()
  }

  async createSnapshot(name: string): Promise<VmDetails> {
    const details = await this.details()
    if (!details.disks.system) throw new DaemonError('conflict', 'The workspace VM has not been created yet')
    if (details.snapshots.some((s) => s.name === name))
      throw new DaemonError('conflict', `A restore point named ${name} already exists`)
    this.launch('snapshot_create', () => this.whileStopped(() => this.deps.vm.snapshot('create', name)))
    return this.details()
  }

  async restoreSnapshot(name: string): Promise<VmDetails> {
    await this.requireSnapshot(name)
    this.launch('snapshot_restore', () => this.whileStopped(() => this.deps.vm.snapshot('restore', name)))
    return this.details()
  }

  async deleteSnapshot(name: string): Promise<VmDetails> {
    await this.requireSnapshot(name)
    this.launch('snapshot_delete', () => this.whileStopped(() => this.deps.vm.snapshot('delete', name)))
    return this.details()
  }

  private async requireSnapshot(name: string): Promise<void> {
    if (!(await this.details()).snapshots.some((s) => s.name === name))
      throw new DaemonError('not_found', `restore point not found: ${name}`)
  }

  /** Waits for a pending system update and the current task (tests). */
  async settled(): Promise<void> {
    while (this.waiting || this.running) {
      await this.waiting
      await this.running
    }
  }
}

/** Default restore point name: `snap-YYYYMMDD-HHMMSS` (local time). */
export function snapshotName(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `snap-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
