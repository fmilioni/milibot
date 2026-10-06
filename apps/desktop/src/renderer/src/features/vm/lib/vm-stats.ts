import type { VmStats, VmStatsDisk } from '@milibot/shared'

import type { UsageTone } from '@/features/providers/lib/cli-usage'

const USAGE_WARNING_PERCENT = 75
const USAGE_DANGER_PERCENT = 90
/** Length of the charts, matching the history the runtime keeps. */
const HISTORY_WINDOW_SEC = 300

/** Green below 75%, yellow below 90%, red beyond. */
export function usageTone(percent: number): UsageTone {
  if (percent >= USAGE_DANGER_PERCENT) return 'danger'
  if (percent >= USAGE_WARNING_PERCENT) return 'warning'
  return 'success'
}

export function percentOf(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

export function memoryPercent(stats: VmStats): number {
  return percentOf(stats.memory.usedBytes, stats.memory.totalBytes)
}

export function diskPercent(disk: VmStatsDisk | null): number {
  return disk ? percentOf(disk.usedBytes, disk.totalBytes) : 0
}

/** Both disks together (the headline number of the disk column). */
export function diskTotals(stats: VmStats): VmStatsDisk {
  const disks = [stats.disks.system, stats.disks.data].filter((d): d is VmStatsDisk => d !== null)
  return {
    usedBytes: disks.reduce((sum, d) => sum + d.usedBytes, 0),
    totalBytes: disks.reduce((sum, d) => sum + d.totalBytes, 0),
  }
}

/** The fullest disk, when it deserves a warning. */
export function fullestDisk(stats: VmStats): { disk: 'system' | 'data'; percent: number } | null {
  const candidates = (['system', 'data'] as const).map((disk) => ({
    disk,
    percent: diskPercent(stats.disks[disk]),
  }))
  const fullest = candidates.sort((a, b) => b.percent - a.percent)[0]
  return fullest && fullest.percent >= USAGE_WARNING_PERCENT ? fullest : null
}

/**
 * Bar heights (0..1) of the last 5 minutes, one slot per sample; slots before the first sample are null,
 * so a VM that just booted fills the chart from the right.
 */
export function historyBars(stats: VmStats, pick: 'cpu' | 'memory'): Array<number | null> {
  const slots = Math.max(1, Math.round(HISTORY_WINDOW_SEC / stats.intervalSec))
  const values = stats.history
    .slice(-slots)
    .map((s) =>
      pick === 'cpu' ? s.cpuPercent / 100 : percentOf(s.memoryUsedBytes, stats.memory.totalBytes) / 100,
    )
  return [...Array<null>(slots - values.length).fill(null), ...values]
}

export function peakCpu(stats: VmStats): number {
  return Math.max(0, ...stats.history.map((s) => s.cpuPercent))
}

export interface BotUsageRow {
  /** Null: everything outside the bots (Linux, services, Docker). */
  botId: string | null
  cpuPercent: number
  memoryBytes: number
}

/**
 * Heaviest bots first, by memory (it moves slowly, so rows don't jump on every sample); bots the app doesn't
 * know are left out; "other" last.
 */
export function botUsageRows(stats: VmStats, knownBots: ReadonlySet<string>): BotUsageRow[] {
  const bots = stats.bots
    .filter((b) => knownBots.has(b.botId))
    .sort((a, b) => b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent)
  return [...bots, { botId: null, ...stats.other }]
}

/** `ms` comes from `now - startedAt`; a `now` refreshed before the VM started makes it negative, shown as 0. */
export function formatUptime(
  ms: number,
  t: (
    key: 'settings.vm.uptimeDays' | 'settings.vm.uptimeHours' | 'settings.vm.uptimeMinutes',
    o: Record<string, number>,
  ) => string,
): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return t('settings.vm.uptimeDays', { days, hours })
  if (hours > 0) return t('settings.vm.uptimeHours', { hours, minutes: minutes % 60 })
  return t('settings.vm.uptimeMinutes', { minutes })
}
