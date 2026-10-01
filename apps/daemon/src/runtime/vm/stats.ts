import type { LogFn, VmInfo, VmStats, VmStatsSample } from '@milibot/shared'
import type { GuestStats } from '@milibot/shared'

import type { VmController } from './controller'

export const STATS_INTERVAL_MS = 5_000
/** TCG guests are several times slower: sample less often. */
export const STATS_INTERVAL_SLOW_MS = 10_000
const STATS_WINDOW_MS = 5 * 60_000
/** The second reading comes sooner so usage shows up right after boot. */
export const STATS_FIRST_DELTA_MS = 1_000

export interface BotRef {
  id: string
  slug: string
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

/**
 * One usage sample from two raw guest readings (CPU is a delta of cumulative counters). Bots are matched by
 * slug; slices of bots the workspace no longer has count as "other".
 */
export function computeVmStats(
  prev: GuestStats,
  cur: GuestStats,
  bots: BotRef[],
  history: VmStatsSample[],
  intervalSec: number,
): VmStats {
  const totalTicks = cur.cpu.totalTicks - prev.cpu.totalTicks
  const idleTicks = cur.cpu.idleTicks - prev.cpu.idleTicks
  const cpuPercent = totalTicks > 0 ? clampPercent(100 * (1 - idleTicks / totalTicks)) : 0
  const usedBytes = Math.max(0, cur.memory.totalBytes - cur.memory.availableBytes)
  const cpuBudgetUsec = Math.max(1, (cur.at - prev.at) * 1000 * Math.max(1, cur.cpus))

  const botById = new Map(bots.map((b) => [b.slug, b.id]))
  const prevUsage = new Map(prev.bots.map((b) => [b.slug, b.cpuUsageUsec]))
  const botStats = cur.bots.flatMap((b) => {
    const botId = botById.get(b.slug)
    if (!botId) return []
    const before = prevUsage.get(b.slug)
    const delta = before === undefined ? 0 : Math.max(0, b.cpuUsageUsec - before)
    return [{ botId, cpuPercent: clampPercent((100 * delta) / cpuBudgetUsec), memoryBytes: b.memoryBytes }]
  })
  const botsCpu = botStats.reduce((sum, b) => sum + b.cpuPercent, 0)
  const botsMemory = botStats.reduce((sum, b) => sum + b.memoryBytes, 0)

  const disk = (path: string) => {
    const d = cur.disks.find((x) => x.path === path)
    return d ? { usedBytes: d.usedBytes, totalBytes: d.totalBytes } : null
  }

  return {
    at: cur.at,
    intervalSec,
    uptimeSec: cur.uptimeSec,
    cpus: cur.cpus,
    loadavg: cur.loadavg,
    cpuPercent,
    memory: { totalBytes: cur.memory.totalBytes, usedBytes, cacheBytes: cur.memory.cacheBytes },
    disks: { system: disk('/'), data: disk('/data') },
    bots: botStats,
    other: {
      cpuPercent: Math.max(0, cpuPercent - botsCpu),
      memoryBytes: Math.max(0, usedBytes - botsMemory),
    },
    history: [...history, { at: cur.at, cpuPercent, memoryUsedBytes: usedBytes }],
  }
}

/**
 * Samples `GET /stats` while the VM is running, one request at a time (the guest's port forward has a
 * backlog of 1). History lives only in memory and restarts with the VM.
 */
export class VmStatsSampler {
  private prev: GuestStats | null = null
  private latest: VmStats | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped on every start/stop: a tick of an older run drops its result. */
  private generation = 0
  private running = false
  private failing = false
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly deps: {
      vm: Pick<VmController, 'info' | 'runningGuest' | 'subscribe' | 'softwareEmulated'>
      bots: () => BotRef[]
      log?: LogFn
    },
  ) {}

  start(): void {
    this.unsubscribe = this.deps.vm.subscribe((info) => this.onVmInfo(info))
    this.onVmInfo(this.deps.vm.info())
  }

  current(): VmStats | null {
    return this.latest
  }

  close(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.halt()
  }

  private onVmInfo(info: VmInfo): void {
    if (info.state === 'running') this.sample()
    else this.halt()
  }

  private sample(): void {
    if (this.running) return
    this.running = true
    void this.tick(++this.generation)
  }

  private halt(): void {
    this.running = false
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.prev = null
    this.latest = null
  }

  private intervalMs(): number {
    return this.deps.vm.softwareEmulated() ? STATS_INTERVAL_SLOW_MS : STATS_INTERVAL_MS
  }

  private async tick(generation: number): Promise<void> {
    this.timer = null
    const intervalMs = this.intervalMs()
    try {
      const cur = await this.deps.vm.runningGuest().stats()
      if (generation !== this.generation) return
      if (this.prev) {
        const keep = Math.round(STATS_WINDOW_MS / intervalMs) - 1
        const history = keep > 0 ? (this.latest?.history ?? []).slice(-keep) : []
        this.latest = computeVmStats(this.prev, cur, this.deps.bots(), history, intervalMs / 1000)
      }
      this.prev = cur
      this.failing = false
    } catch (err) {
      if (generation !== this.generation) return
      if (!this.failing) this.deps.log?.('warn', 'vm stats unavailable', { err: (err as Error).message })
      this.failing = true
    }
    const delay = this.prev && !this.latest ? STATS_FIRST_DELTA_MS : intervalMs
    this.timer = setTimeout(() => void this.tick(generation), delay)
    this.timer.unref?.()
  }
}
