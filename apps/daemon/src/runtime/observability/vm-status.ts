import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { toolText } from '@milibot/agent/tools'
import type { VmDetails, VmDiskUsage, VmStats, VmStatsDisk } from '@milibot/shared'

import { type ToolHandlers, ToolSwitch } from '../tools-core'
import type { VmAdmin, VmStatsSampler } from '../vm'

const MAX_SNAPSHOTS = 10

export interface VmStatusToolsDeps {
  admin: Pick<VmAdmin, 'details'>
  stats: Pick<VmStatsSampler, 'current'>
  botName(id: string): string | null
  now(): number
}

const GB = 1024 ** 3
const MB = 1024 ** 2

function bytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`
  return `${Math.round(n / MB)} MB`
}

const percent = (n: number) => `${Math.round(n)}%`
const iso = (ms: number) => new Date(ms).toISOString()

function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

const TASK_STATUS: Record<NonNullable<VmDetails['task']>['status'], string> = {
  waiting_idle: 'waiting for the bots to be idle',
  running: 'running',
  done: 'done',
  error: 'failed',
}

const UPDATE_STATUS: Record<NonNullable<VmDetails['systemUpdate']>['status'], string> = {
  waiting_golden: 'waiting for the new system image to be built',
  waiting_idle: 'waiting for the bots to be idle',
  waiting_task: 'waiting for another VM operation to finish',
}

function hostDisk(name: string, disk: VmDiskUsage | null): string {
  if (!disk) return `${name} not created`
  const used =
    disk.actualBytes == null ? 'size on the host unknown' : `${bytes(disk.actualBytes)} used on the host`
  return `${name} ${bytes(disk.virtualBytes)} (${used})`
}

function guestDisk(name: string, disk: VmStatsDisk | null): string {
  if (!disk) return `${name} unknown`
  const share = disk.totalBytes > 0 ? ` (${percent((disk.usedBytes / disk.totalBytes) * 100)})` : ''
  return `${name} ${bytes(disk.usedBytes)} of ${bytes(disk.totalBytes)}${share}`
}

function detailLines(d: VmDetails, now: number): string[] {
  const { vm } = d
  const state = vm.phase ? `${vm.state} (${vm.phase})` : vm.state
  const lines = [`State: ${state}`]
  if (vm.state === 'error') {
    const code = vm.errorCode ? ` [${vm.errorCode}]` : ''
    lines.push(`Error${code}: ${vm.error ?? 'unknown'}`)
  }
  if (d.startedAt != null) lines.push(`Running since ${iso(d.startedAt)} (${duration(now - d.startedAt)})`)
  const configured = `${vm.config.cpus} CPUs, ${vm.config.memGb} GB memory`
  if (d.running) {
    const resources = `Resources: ${d.running.cpus} CPUs, ${d.running.memGb} GB memory`
    lines.push(
      d.pendingRestart ? `${resources} (configured ${configured}: applies on the next restart)` : resources,
    )
  } else {
    lines.push(`Resources (configured): ${configured}`)
  }
  lines.push(`Disks: ${hostDisk('system', d.disks.system)}; ${hostDisk('data', d.disks.data)}`)
  if (vm.system) {
    const { revision, latestRevision, goldenVersion } = vm.system
    const version = goldenVersion ? ` (${goldenVersion})` : ''
    const update =
      revision < latestRevision ? `, a system update to revision ${latestRevision} is available` : ''
    lines.push(`System image: revision ${revision}${version}${update}`)
  }
  lines.push(`Bots working now: ${d.workingBots}`)
  if (d.task) {
    const error = d.task.error ? `: ${d.task.error}` : ''
    lines.push(
      `VM operation: ${d.task.kind}, ${TASK_STATUS[d.task.status]}${error} (started ${iso(d.task.startedAt)})`,
    )
  }
  if (d.systemUpdate) {
    const when = d.systemUpdate.whenIdle ? ', when the bots are idle' : ''
    lines.push(
      `System update requested ${iso(d.systemUpdate.requestedAt)}: ${UPDATE_STATUS[d.systemUpdate.status]}${when}`,
    )
  }
  if (d.snapshots.length) {
    const shown = d.snapshots
      .slice(0, MAX_SNAPSHOTS)
      .map((s) => (s.createdAt == null ? s.name : `${s.name} (${iso(s.createdAt)})`))
    const more = d.snapshots.length > MAX_SNAPSHOTS ? `, and ${d.snapshots.length - MAX_SNAPSHOTS} more` : ''
    lines.push(`Restore points (${d.snapshots.length}): ${shown.join(', ')}${more}`)
  } else {
    lines.push('Restore points: none')
  }
  return lines
}

function usageLines(s: VmStats, me: string, botName: (id: string) => string | null): string[] {
  const peak = Math.max(0, ...s.history.map((h) => h.cpuPercent))
  const window = s.history.length > 1 ? duration((s.history.at(-1)?.at ?? 0) - (s.history[0]?.at ?? 0)) : null
  const lines = [
    `Usage at ${iso(s.at)} (sampled every ${s.intervalSec} s, VM up ${duration(s.uptimeSec * 1000)}):`,
    `- CPU ${percent(s.cpuPercent)} of ${s.cpus} CPUs (load ${s.loadavg.map((n) => n.toFixed(2)).join(' ')}` +
      (window ? `; peak ${percent(peak)} in the last ${window})` : ')'),
    `- Memory ${bytes(s.memory.usedBytes)} used of ${bytes(s.memory.totalBytes)} (+${bytes(s.memory.cacheBytes)} cache)`,
    `- Disks inside the VM: ${guestDisk('system', s.disks.system)}; ${guestDisk('data', s.disks.data)}`,
    '- By bot (CPU share of the whole VM, memory):',
  ]
  // Heaviest first by memory, as the app lists them; bots no longer in the workspace are left out.
  const bots = s.bots
    .map((b) => ({ ...b, name: botName(b.botId) }))
    .filter((b): b is typeof b & { name: string } => b.name !== null)
    .sort((a, b) => b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent)
  for (const b of bots) {
    const you = b.botId === me ? ' (you)' : ''
    lines.push(`  - ${b.name}${you}: CPU ${percent(b.cpuPercent)}, memory ${bytes(b.memoryBytes)}`)
  }
  lines.push(
    `  - Other (Linux, services, Docker): CPU ${percent(s.other.cpuPercent)}, memory ${bytes(s.other.memoryBytes)}`,
  )
  return lines
}

/** The VM screen as text: the settings' details plus the live usage, the same sources the app reads. */
async function vmStatusText(ctx: ToolExecContext, deps: VmStatusToolsDeps): Promise<string> {
  const details = await deps.admin.details()
  const stats = deps.stats.current()
  const lines = detailLines(details, deps.now())
  if (stats) lines.push(...usageLines(stats, ctx.bot.id, deps.botName))
  else if (details.vm.state === 'running') lines.push('Usage: not sampled yet (try again in a few seconds)')
  else lines.push('Usage: none (the VM is not running)')
  return lines.join('\n')
}

/** `vm_status`: read-only; the VM's actions (start, stop, restart, restore points) stay in the app. */
export class VmStatusTools extends ToolSwitch {
  readonly name = 'vm status'
  protected readonly handlers: ToolHandlers

  constructor(deps: VmStatusToolsDeps) {
    super()
    this.handlers = {
      vm_status: async (ctx): Promise<ToolResult> => toolText(await vmStatusText(ctx, deps)),
    }
  }
}
