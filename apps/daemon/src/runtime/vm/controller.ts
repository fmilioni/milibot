import { readFileSync, statSync } from 'node:fs'

import type {
  Bot,
  BotLimits,
  LogFn,
  VmCliDisk,
  VmConfig,
  VmDiskKind,
  VmDiskUsage,
  VmInfo,
  VmLifecycleState,
  VmRunningRecord,
  VmSnapshot,
  WorkspaceStatus,
} from '@milibot/shared'
import {
  DEFAULT_VM_CONFIG,
  isWhpxIrqchipFailureLog,
  VmCliStartOutput,
  VmCliStatus,
  VmConfigFileView,
} from '@milibot/shared'
import { pidAlive } from '@milibot/vm-host'

import { workspacePaths } from '../../config/paths'
import { goldenRevision, goldenVersionOf } from '../../golden/revision'
import { sleep } from '../../util/sleep'
import { type GuestAgentBundle, parseVmCliOutput, type VmCli, VmCliError } from '../../vm-cli'
import { GuestClient, GuestError } from './guest-client'

/** Per-workspace VM control surface used by the runtime handlers, the tools and the agent host. */
export interface VmController {
  status(): WorkspaceStatus['vm']
  info(): VmInfo
  /** Creates (first time) and boots the VM; resolves once the guest agent answers and bots are provisioned. */
  start(): Promise<void>
  stop(options?: { force?: boolean }): Promise<void>
  /** Moves the system disk to the newest golden image (the data disk is kept); boots it unless `boot: false`. */
  reset(options?: { boot?: boolean }): Promise<void>
  /** Guest agent client; boots the VM first when needed. */
  guest(): Promise<GuestClient>
  /** Guest agent client only while the VM is running (never boots it). */
  runningGuest(): GuestClient
  provisionBot(bot: Pick<Bot, 'slug' | 'linuxUid' | 'displayNum'>): Promise<void>
  /**
   * Removes a deleted bot's Linux user, desktop and home (never /workspace). Resolves false when the
   * VM is not running: bots still pending are removed on the next boot, before provisioning.
   */
  removeBot(slug: string): Promise<boolean>
  vncPort(display: number): number | null
  /** True when a QEMU process of this workspace is alive (e.g. left running by a previous runtime). */
  processRunning(): boolean
  close(): Promise<void>
  /** Disks, restore points and what the running QEMU booted with (settings screen). */
  details(): Promise<VmRuntimeDetails>
  /** CPUs/memory of the next boot (the VM config; settings cover a VM not created yet). */
  resize(config: { cpus?: number; memGb?: number }): Promise<void>
  /** Only with the VM stopped; never shrinks. */
  growDisk(disk: VmDiskKind, sizeGb: number): Promise<void>
  /** Restore points of the system disk; create/restore/delete only with the VM stopped. */
  snapshot(action: 'create' | 'restore' | 'delete', name: string): Promise<void>
  /** Called on every state change (after the change is visible in `info()`). */
  subscribe(listener: (info: VmInfo) => void): () => void
  /** Applies the current per-bot CPU/memory limits (or clears them) in the running VM. */
  applyBotLimits(): Promise<void>
  /** Revision of the newest golden image on disk (null: missing) and the one this app version builds. */
  goldenRevisions(): { available: number | null; latest: number }
  /** The running QEMU uses software emulation (TCG): the guest is several times slower. */
  softwareEmulated(): boolean
}

export function isVmRunning(vm: Pick<VmController, 'status'>): boolean {
  return vm.status().state === 'running'
}

/**
 * Calls `up` when the VM becomes running (right away when it already is) and `down` when it stops running;
 * returns the unsubscribe function.
 */
export function onVmTransition(
  vm: Pick<VmController, 'status' | 'subscribe'>,
  handlers: { up?: () => void; down?: () => void },
): () => void {
  let running = isVmRunning(vm)
  const unsubscribe = vm.subscribe((info) => {
    const now = info.state === 'running'
    if (now === running) return
    running = now
    if (now) handlers.up?.()
    else handlers.down?.()
  })
  if (running) handlers.up?.()
  return unsubscribe
}

/** Runs `fn` whenever the VM becomes running (right away when it already is); returns the unsubscribe function. */
export function whenVmRunning(vm: Pick<VmController, 'status' | 'subscribe'>, fn: () => void): () => void {
  return onVmTransition(vm, { up: fn })
}

export interface VmRuntimeDetails {
  running: { cpus: number; memGb: number } | null
  startedAt: number | null
  disks: { system: VmDiskUsage | null; data: VmDiskUsage | null }
  snapshots: VmSnapshot[]
}

const EMPTY_DETAILS: VmRuntimeDetails = {
  running: null,
  startedAt: null,
  disks: { system: null, data: null },
  snapshots: [],
}

function diskUsage(disk: VmCliDisk): VmDiskUsage | null {
  if (!disk.exists) return null
  return { virtualBytes: disk.virtualBytes, actualBytes: disk.actualBytes }
}

/** Resources of the running VM from its config.json record, only if it belongs to the live `pid`. */
export function runningResources(
  running: VmRunningRecord | undefined,
  pid: number | null,
): { cpus: number; memGb: number } | null {
  if (!pid || !running || running.pid !== pid) return null
  return { cpus: running.cpus, memGb: running.memGb }
}

export interface QemuVmOptions {
  workspaceDir: string
  workspaceName: string
  /** Allocated by the supervisor; the VM's config.json wins once the VM exists. */
  portBase: number | null
  cli: VmCli
  golden: () => string | null
  settings: () => VmConfig
  bots: () => Array<Pick<Bot, 'slug' | 'linuxUid' | 'displayNum'>>
  /** Deleted bots whose desktop may still exist in the VM. */
  pendingRemovals?: () => Array<{ slug: string }>
  onBotRemoved?: (slug: string) => void
  emit: (info: VmInfo) => void
  log?: LogFn
  bootTimeoutMs?: number
  /**
   * Windows: how long a first boot with WHPX's default irqchip may take before it is retried with
   * `kernel-irqchip=off` (a guest stuck on the hypervisor's APIC hangs instead of exiting). Default 120 s.
   */
  whpxProbeTimeoutMs?: number
  pollIntervalMs?: number
  watchIntervalMs?: number
  guestFactory?: (baseUrl: string, token: string) => GuestClient
  /** Golden revision this app version builds (`vm/golden-revision`); default 1. */
  latestGoldenRevision?: () => number
  /** Guest agent bundle shipped with the app: an older agent found in the VM at boot is replaced by it. */
  agentBundle?: () => GuestAgentBundle | null
  /** Per-bot CPU/memory limits (null: none), applied to each bot's systemd slice. */
  botLimits?: () => BotLimits | null
}

/**
 * Replaces the guest agent and restarts it a second later (after this request has been answered). Runs as
 * root through the old agent's `/exec`, so VMs created from an older image get the new endpoints.
 */
const AGENT_UPDATE_SCRIPT = [
  'set -e',
  'f=/opt/milibot/guest-agent/guest-agent.mjs',
  'cat > "$f.new"',
  'chmod 0644 "$f.new"',
  'mv "$f.new" "$f"',
  'systemd-run --quiet --collect --on-active=1 systemctl restart milibot-guest-agent.service',
].join('\n')

function desktopKey(slug: string, uid: number | undefined, display: number): string {
  return `${slug}:${uid ?? '?'}:${display}`
}

export class QemuVmController implements VmController {
  private state: VmLifecycleState = 'not_created'
  private phase: VmInfo['phase']
  private error: { code: string; message: string } | null = null
  private desktops = new Set<string>()
  private booting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private client: GuestClient | null = null
  private watchTimer: NodeJS.Timeout | null = null
  private closed = false
  private readonly listeners = new Set<(info: VmInfo) => void>()
  private readonly paths: ReturnType<typeof workspacePaths>
  /** The pid last confirmed to be this VM's QEMU (a live pid can't be reused, so it is only checked once). */
  private confirmedPid: number | null = null

  constructor(private readonly options: QemuVmOptions) {
    this.paths = workspacePaths(options.workspaceDir)
    this.state = this.detectState()
  }

  private fileConfig(): VmConfigFileView | null {
    try {
      const parsed = VmConfigFileView.safeParse(JSON.parse(readFileSync(this.paths.vmConfig, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** The live QEMU of `qemu.pid`; a stale file naming another process (pid reused after a reboot) is ignored. */
  private qemuPid(): number | null {
    let pid: number
    try {
      pid = Number(readFileSync(this.paths.qemuPid, 'utf8').trim())
    } catch {
      return null
    }
    if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null
    if (pid === this.confirmedPid) return pid
    if (this.options.cli.isVmProcess && !this.options.cli.isVmProcess(pid)) return null
    this.confirmedPid = pid
    return pid
  }

  private detectState(): VmLifecycleState {
    return this.fileConfig() ? 'stopped' : 'not_created'
  }

  private portBase(): number | null {
    return this.fileConfig()?.portBase ?? this.options.portBase
  }

  private setState(state: VmLifecycleState, error: { code: string; message: string } | null = null): void {
    this.state = state
    this.error = error
    if (state !== 'starting') this.phase = undefined
    if (state !== 'running') this.desktops.clear()
    const info = this.info()
    this.options.emit(info)
    for (const listener of this.listeners) {
      try {
        listener(info)
      } catch (err) {
        this.log('warn', 'vm listener failed', { err: (err as Error).message })
      }
    }
  }

  subscribe(listener: (info: VmInfo) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async details(): Promise<VmRuntimeDetails> {
    if (!this.fileConfig()) return EMPTY_DETAILS
    const status = parseVmCliOutput(
      VmCliStatus,
      await this.options.cli.run(['status', this.options.workspaceDir], { timeoutMs: 20_000 }),
    )
    const pid = this.qemuPid()
    let startedAt: number | null = null
    if (pid) {
      try {
        startedAt = Math.round(statSync(this.paths.qemuPid).mtimeMs)
      } catch {
        startedAt = null
      }
    }
    return {
      running: runningResources(this.fileConfig()?.running, pid),
      startedAt,
      disks: { system: diskUsage(status.disks.system), data: diskUsage(status.disks.data) },
      snapshots: (status.disks.system.exists ? status.disks.system.snapshots : []).map((snap) => {
        const at = Date.parse(snap.date)
        return { name: snap.name, createdAt: Number.isFinite(at) ? at : null }
      }),
    }
  }

  async resize(config: { cpus?: number; memGb?: number }): Promise<void> {
    if (!this.fileConfig()) return
    const args = ['resize', this.options.workspaceDir]
    if (config.cpus !== undefined) args.push('--cpus', String(config.cpus))
    if (config.memGb !== undefined) args.push('--mem-gb', String(config.memGb))
    if (args.length > 2) await this.options.cli.run(args, { timeoutMs: 20_000 })
    this.options.emit(this.info())
  }

  async growDisk(disk: VmDiskKind, sizeGb: number): Promise<void> {
    if (!this.fileConfig()) throw new VmCliError('NOT_FOUND', 'The workspace VM has not been created yet')
    if (this.qemuPid()) throw new VmCliError('VM_RUNNING', 'Stop the VM before growing a disk')
    await this.options.cli.run(['grow-disk', this.options.workspaceDir, disk, String(sizeGb)], {
      timeoutMs: 120_000,
    })
    this.options.emit(this.info())
  }

  async snapshot(action: 'create' | 'restore' | 'delete', name: string): Promise<void> {
    if (!this.fileConfig()) throw new VmCliError('NOT_FOUND', 'The workspace VM has not been created yet')
    if (this.qemuPid()) throw new VmCliError('VM_RUNNING', 'Stop the VM before changing restore points')
    await this.options.cli.run(['snapshot', action, this.options.workspaceDir, name], { timeoutMs: 300_000 })
  }

  info(): VmInfo {
    const file = this.fileConfig()
    const config = file
      ? { cpus: file.cpus, memGb: file.memGb, dataGb: file.dataGb, systemGb: file.systemGb }
      : this.options.settings()
    return {
      state: this.state,
      config,
      ...(this.error ? { error: this.error.message, errorCode: this.error.code } : {}),
      portBase: this.portBase(),
      desktops: this.desktops.size,
      ...(this.phase ? { phase: this.phase } : {}),
      ...(file?.golden ? { system: this.systemInfo(file.golden) } : {}),
    }
  }

  goldenRevisions(): { available: number | null; latest: number } {
    const golden = this.options.golden()
    return {
      available: golden ? goldenRevision(golden) : null,
      latest: this.options.latestGoldenRevision?.() ?? 1,
    }
  }

  private systemInfo(golden: string): NonNullable<VmInfo['system']> {
    return {
      goldenVersion: goldenVersionOf(golden),
      revision: goldenRevision(golden),
      latestRevision: this.options.latestGoldenRevision?.() ?? 1,
    }
  }

  private setPhase(phase: NonNullable<VmInfo['phase']>): void {
    this.phase = phase
    this.options.emit(this.info())
  }

  status(): WorkspaceStatus['vm'] {
    return { state: this.state, desktops: this.desktops.size }
  }

  processRunning(): boolean {
    return this.qemuPid() !== null
  }

  vncPort(display: number): number | null {
    const base = this.portBase()
    return base === null ? null : base + display
  }

  private log(...args: Parameters<LogFn>): void {
    this.options.log?.(...args)
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('VM controller closed'))
    if (this.state === 'running') return Promise.resolve()
    this.booting ??= this.boot().finally(() => {
      this.booting = null
    })
    return this.booting
  }

  private async boot(): Promise<void> {
    if (this.stopping) await this.stopping
    this.setState('starting')
    try {
      if (!this.fileConfig()) {
        this.setPhase('creating')
        await this.create()
      }
      this.setPhase('booting')
      let slow = this.fileConfig()?.running?.accel === 'tcg'
      let whpxProbe = false
      if (!this.qemuPid()) {
        const output = parseVmCliOutput(
          VmCliStartOutput,
          await this.options.cli.run(['start', this.options.workspaceDir], { timeoutMs: 60_000 }),
        )
        const started = 'alreadyRunning' in output ? null : output
        if (started) slow = started.slow
        if (slow) this.log('warn', 'vm running without hardware acceleration (TCG); boot will be slow')
        if (started?.fallback) this.log('warn', 'vm started after a fallback', { fallback: started.fallback })
        // Neither saved nor forced: this boot tells whether QEMU's default irqchip works on this host.
        whpxProbe =
          started?.accel === 'whpx' &&
          started.whpxKernelIrqchip === 'default' &&
          !started.whpxKernelIrqchipForced
      }
      const guest = this.guestClient()
      if (whpxProbe) await this.waitForWhpxGuest(guest)
      else await this.waitForGuest(guest, slow)
      await this.syncAgent(guest)
      this.client = guest
      this.setPhase('provisioning')
      await this.removePending(guest)
      await this.provisionAll(guest)
      const limits = this.options.botLimits?.() ?? null
      if (limits) await this.applyLimits(guest, this.options.bots(), limits)
      this.setState('running')
      this.watch()
      this.log('info', 'vm running', { desktops: this.desktops.size })
    } catch (err) {
      const code =
        err instanceof VmCliError
          ? err.code
          : err instanceof GuestError
            ? `GUEST_${err.code.toUpperCase()}`
            : 'VM_START_FAILED'
      this.log('error', 'vm start failed', { code, err: (err as Error).message })
      this.client = null
      this.setState('error', { code, message: (err as Error).message })
      throw err
    }
  }

  private async create(): Promise<void> {
    const golden = this.options.golden()
    if (!golden) {
      throw new VmCliError(
        'GOLDEN_NOT_FOUND',
        'The VM golden image was not found; build it again (setup builds it) before creating the workspace VM.',
      )
    }
    const portBase = this.options.portBase
    if (!portBase) throw new VmCliError('NO_PORT_BASE', 'No VM port range allocated for this workspace')
    const config = this.options.settings()
    await this.options.cli.run(
      [
        'create',
        this.options.workspaceDir,
        '--port-base',
        String(portBase),
        '--name',
        this.options.workspaceName,
        '--cpus',
        String(config.cpus),
        '--mem-gb',
        String(config.memGb),
        '--data-gb',
        String(config.dataGb),
        '--system-gb',
        String(config.systemGb),
        '--golden',
        golden,
      ],
      { timeoutMs: 120_000 },
    )
  }

  private guestClient(): GuestClient {
    const base = this.portBase()
    if (!base) throw new VmCliError('NO_PORT_BASE', 'VM has no port base')
    const token = readFileSync(this.paths.agentToken, 'utf8').trim()
    const url = `http://127.0.0.1:${base}`
    return (
      this.options.guestFactory?.(url, token) ??
      new GuestClient(url, token, undefined, {
        onRetry: (info) => this.log('info', 'guest request retried', info),
      })
    )
  }

  /**
   * First boot with WHPX's default irqchip: a guest stuck on the hypervisor's APIC hangs (or QEMU logs
   * failed interrupt injections) instead of exiting. Then the VM is restarted once with
   * `kernel-irqchip=off`, which the VM script saves in config.json for the next boots.
   */
  private async waitForWhpxGuest(guest: GuestClient): Promise<void> {
    try {
      await this.waitForGuest(guest, false, {
        timeoutMs: this.options.whpxProbeTimeoutMs ?? 120_000,
        watchIrqchip: true,
      })
      return
    } catch (err) {
      if (!(err instanceof VmCliError) || !['BOOT_TIMEOUT', 'WHPX_IRQCHIP_FAILED'].includes(err.code))
        throw err
      this.log(
        'warn',
        'guest did not come up with the default WHPX irqchip; retrying with kernel-irqchip=off',
        {
          reason: err.code,
        },
      )
    }
    await this.options.cli.run(['stop', this.options.workspaceDir, '--force'], { timeoutMs: 30_000 })
    await this.options.cli.run(['start', this.options.workspaceDir, '--whpx-kernel-irqchip', 'off'], {
      timeoutMs: 60_000,
    })
    await this.waitForGuest(guest)
  }

  /** Tail of QEMU's own log (`vm/qemu.log`), empty when missing. */
  private qemuLog(): string {
    try {
      return readFileSync(this.paths.qemuLog, 'utf8').slice(-8192)
    } catch {
      return ''
    }
  }

  /** `slow`: software emulation (TCG) boots several times slower, so it gets 3× the time. */
  private async waitForGuest(
    guest: GuestClient,
    slow = false,
    options: { timeoutMs?: number; watchIrqchip?: boolean } = {},
  ): Promise<void> {
    const deadline =
      Date.now() + (options.timeoutMs ?? (this.options.bootTimeoutMs ?? 300_000) * (slow ? 3 : 1))
    const interval = this.options.pollIntervalMs ?? 1000
    for (;;) {
      if (this.closed) throw new Error('VM controller closed')
      if (this.state !== 'starting') throw new VmCliError('BOOT_ABORTED', 'VM boot was interrupted')
      try {
        const health = await guest.health(3000)
        if (health.ok) return
      } catch (err) {
        if (err instanceof GuestError && err.status === 401) throw err
      }
      if (options.watchIrqchip && isWhpxIrqchipFailureLog(this.qemuLog())) {
        throw new VmCliError('WHPX_IRQCHIP_FAILED', 'WHPX failed with the default kernel-irqchip')
      }
      if (!this.qemuPid()) throw new VmCliError('VM_DIED', 'The VM exited during boot (see vm/serial.log)')
      if (Date.now() > deadline)
        throw new VmCliError('BOOT_TIMEOUT', 'The guest agent did not answer in time')
      await sleep(interval)
    }
  }

  /** Never fails the boot: an agent that could not be updated keeps working without the new endpoints. */
  private async syncAgent(guest: GuestClient): Promise<void> {
    const bundle = this.options.agentBundle?.()
    if (!bundle) return
    try {
      const health = await guest.health(5000)
      if (health.agentSha === bundle.sha) return
      const { procs } = await guest.listProcs()
      if (procs.some((p) => p.running)) {
        this.log('info', 'guest agent update postponed: processes are running', { from: health.agentSha })
        return
      }
      this.log('info', 'updating the guest agent', { from: health.agentSha ?? 'unknown', to: bundle.sha })
      const result = await guest.exec({
        user: 'root',
        cmd: AGENT_UPDATE_SCRIPT,
        cwd: '/',
        stdin: bundle.content,
        timeoutMs: 30_000,
      })
      if (result.code !== 0) throw new Error(result.stderr.trim() || `exit ${result.code}`)
      const deadline = Date.now() + 60_000
      for (;;) {
        await sleep(this.options.pollIntervalMs ?? 1000)
        const current = await guest.health(3000).catch(() => null)
        if (current?.agentSha === bundle.sha) return
        if (Date.now() > deadline) throw new Error('the new guest agent did not answer in time')
      }
    } catch (err) {
      this.log('warn', 'guest agent update failed', { err: (err as Error).message })
      await this.waitForGuest(guest)
    }
  }

  private async applyLimits(
    guest: GuestClient,
    bots: Array<Pick<Bot, 'slug' | 'linuxUid'>>,
    limits: BotLimits | null,
  ): Promise<void> {
    if (bots.length === 0) return
    try {
      const { results } = await guest.applyLimits(
        bots.map((b) => ({ slug: b.slug, uid: b.linuxUid })),
        limits,
      )
      for (const failed of results.filter((r) => !r.ok))
        this.log('warn', 'bot limits not applied', { slug: failed.slug, err: failed.error })
    } catch (err) {
      this.log('warn', 'bot limits not applied', { err: (err as Error).message })
    }
  }

  async applyBotLimits(): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined)
    if (this.state !== 'running' || !this.client) return
    await this.applyLimits(this.client, this.options.bots(), this.options.botLimits?.() ?? null)
  }

  private async removePending(guest: GuestClient): Promise<void> {
    const active = new Set(this.options.bots().map((b) => b.slug))
    for (const { slug } of this.options.pendingRemovals?.() ?? []) {
      if (active.has(slug)) continue
      try {
        await guest.removeBot({ slug, deleteHome: true })
        this.options.onBotRemoved?.(slug)
        this.log('info', 'deleted bot removed from the VM', { slug })
      } catch (err) {
        this.log('warn', 'could not remove deleted bot from the VM', { slug, err: (err as Error).message })
      }
    }
  }

  async removeBot(slug: string): Promise<boolean> {
    if (this.booting) await this.booting.catch(() => undefined)
    if (this.state !== 'running' || !this.client) return false
    await this.client.removeBot({ slug, deleteHome: true })
    this.desktops.delete(slug)
    this.options.onBotRemoved?.(slug)
    this.options.emit(this.info())
    return true
  }

  /** Desktops already up with the bot's uid and display: provisioning them again would restart them. */
  private async runningDesktops(guest: GuestClient): Promise<Set<string>> {
    try {
      const { displays } = await guest.health(5000)
      return new Set(
        (displays ?? []).filter((d) => d.running).map((d) => desktopKey(d.slug, d.uid, d.display)),
      )
    } catch {
      return new Set()
    }
  }

  private async provisionAll(guest: GuestClient): Promise<void> {
    const running = await this.runningDesktops(guest)
    for (const bot of this.options.bots()) {
      if (running.has(desktopKey(bot.slug, bot.linuxUid, bot.displayNum))) {
        this.desktops.add(bot.slug)
        continue
      }
      try {
        await guest.provisionBot({ slug: bot.slug, uid: bot.linuxUid, display: bot.displayNum })
        this.desktops.add(bot.slug)
      } catch (err) {
        this.log('warn', 'bot provisioning failed', { slug: bot.slug, err: (err as Error).message })
      }
    }
  }

  async provisionBot(bot: Pick<Bot, 'slug' | 'linuxUid' | 'displayNum'>): Promise<void> {
    if (this.booting) await this.booting.catch(() => undefined)
    if (this.state !== 'running' || !this.client || this.desktops.has(bot.slug)) return
    const running = await this.runningDesktops(this.client)
    if (!running.has(desktopKey(bot.slug, bot.linuxUid, bot.displayNum)))
      await this.client.provisionBot({ slug: bot.slug, uid: bot.linuxUid, display: bot.displayNum })
    this.desktops.add(bot.slug)
    this.options.emit(this.info())
    const limits = this.options.botLimits?.() ?? null
    if (limits) await this.applyLimits(this.client, [bot], limits)
  }

  softwareEmulated(): boolean {
    return this.fileConfig()?.running?.accel === 'tcg'
  }

  runningGuest(): GuestClient {
    if (this.state !== 'running' || !this.client)
      throw new VmCliError('VM_UNAVAILABLE', 'The workspace VM is not running')
    return this.client
  }

  async guest(): Promise<GuestClient> {
    if (this.state !== 'running' || !this.client) await this.start()
    if (!this.client) throw new VmCliError('VM_UNAVAILABLE', 'The workspace VM is not running')
    return this.client
  }

  private watch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = setInterval(() => {
      if (this.state === 'running' && !this.qemuPid()) {
        this.log('warn', 'vm process exited')
        this.client = null
        this.setState('stopped')
      }
    }, this.options.watchIntervalMs ?? 5000)
    this.watchTimer.unref()
  }

  stop(options: { force?: boolean } = {}): Promise<void> {
    this.stopping ??= this.doStop(options).finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  private async doStop(options: { force?: boolean }): Promise<void> {
    if (!this.fileConfig()) return
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
    this.client = null
    if (this.qemuPid()) {
      this.setState('stopping')
      try {
        await this.options.cli.run(
          ['stop', this.options.workspaceDir, ...(options.force ? ['--force'] : ['--timeout-sec', '60'])],
          { timeoutMs: 90_000 },
        )
      } catch (err) {
        this.log('error', 'vm stop failed', { err: (err as Error).message })
        this.setState('error', {
          code: err instanceof VmCliError ? err.code : 'VM_STOP_FAILED',
          message: (err as Error).message,
        })
        throw err
      }
    }
    if (this.booting) await this.booting.catch(() => undefined)
    this.setState('stopped')
  }

  async reset(options: { boot?: boolean } = {}): Promise<void> {
    await this.stop()
    const golden = this.options.golden()
    await this.options.cli.run(
      ['reset-system', this.options.workspaceDir, ...(golden ? ['--golden', golden] : [])],
      {
        timeoutMs: 120_000,
      },
    )
    this.options.emit(this.info())
    if (options.boot !== false) await this.start()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
  }
}

export function createPlaceholderVm(): VmController {
  const info: VmInfo = { state: 'not_created', config: DEFAULT_VM_CONFIG, portBase: null, desktops: 0 }
  const unavailable = () =>
    Promise.reject(new VmCliError('VM_UNAVAILABLE', 'No VM is configured for this runtime'))
  return {
    status: () => ({ state: 'not_created', desktops: 0 }),
    info: () => info,
    start: unavailable,
    stop: async () => {},
    reset: unavailable,
    guest: unavailable,
    runningGuest: () => {
      throw new VmCliError('VM_UNAVAILABLE', 'No VM is configured for this runtime')
    },
    provisionBot: async () => {},
    removeBot: async () => false,
    vncPort: () => null,
    processRunning: () => false,
    close: async () => {},
    details: async () => EMPTY_DETAILS,
    resize: async () => {},
    growDisk: unavailable,
    snapshot: unavailable,
    subscribe: () => () => undefined,
    applyBotLimits: async () => {},
    goldenRevisions: () => ({ available: null, latest: 1 }),
    softwareEmulated: () => false,
  }
}
