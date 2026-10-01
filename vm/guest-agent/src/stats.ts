import { readFileSync, statfsSync } from 'node:fs'
import os from 'node:os'

import type {
  GuestCgroupUsage as CgroupUsage,
  GuestCpuTimes as CpuTimes,
  GuestDiskStats as DiskStats,
  GuestMemoryInfo as MemoryInfo,
  GuestStats,
} from '@milibot/shared/portable/guest-api'

import { type BotRef, botSliceName, userSliceName } from './limits.ts'

const CGROUP_ROOT = '/sys/fs/cgroup'

export type ReadText = (path: string) => string
const readText: ReadText = (path) => readFileSync(path, 'utf8')

/** Aggregate `cpu` line of /proc/stat. */
export function parseProcStat(text: string): CpuTimes {
  const line = text.split('\n').find((l) => l.startsWith('cpu '))
  if (!line) throw new Error('no cpu line in /proc/stat')
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields
  return {
    totalTicks: user + nice + system + idle + iowait + irq + softirq + steal,
    idleTicks: idle + iowait,
  }
}

/** Values of `Key: <n> kB` lines, in bytes. */
function kbLines(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)(?:\s+kB)?$/.exec(line.trim())
    if (m) out[m[1]!] = Number(m[2]) * (line.includes('kB') ? 1024 : 1)
  }
  return out
}

export function parseMeminfo(text: string): MemoryInfo {
  const v = kbLines(text)
  const totalBytes = v.MemTotal ?? 0
  return {
    totalBytes,
    availableBytes: v.MemAvailable ?? v.MemFree ?? 0,
    cacheBytes: (v.Buffers ?? 0) + (v.Cached ?? 0) + (v.SReclaimable ?? 0),
  }
}

/** `key value` lines (cgroup v2 cpu.stat / memory.stat). */
export function parseFlatKeyed(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const [k, n] = line.trim().split(/\s+/)
    if (k && n !== undefined && /^\d+$/.test(n)) out[k] = Number(n)
  }
  return out
}

/**
 * Directory of a slice in the cgroup tree: dashes nest (`a-b.slice` lives in `a.slice/a-b.slice`). Escaped
 * dashes (`\x2d`) contain no `-`, so they stay in one segment, as systemd does.
 */
export function sliceCgroupPath(unit: string): string {
  const parts = unit.replace(/\.slice$/, '').split('-')
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('-')}.slice`).join('/')
}

export function readCgroupUsage(unit: string, read: ReadText = readText): CgroupUsage | null {
  const dir = `${CGROUP_ROOT}/${sliceCgroupPath(unit)}`
  try {
    const current = Number(read(`${dir}/memory.current`).trim())
    const memStat = parseFlatKeyed(read(`${dir}/memory.stat`))
    const cpuStat = parseFlatKeyed(read(`${dir}/cpu.stat`))
    return {
      memoryBytes: Math.max(0, current - (memStat.inactive_file ?? 0)),
      cpuUsageUsec: cpuStat.usage_usec ?? 0,
    }
  } catch {
    return null
  }
}

/** A bot's programs run in its own slice and in its login slice (`user-<uid>.slice`): disjoint cgroups, so they add up. */
export function botUsage(bot: BotRef, read: ReadText = readText): CgroupUsage {
  const usage: CgroupUsage = { memoryBytes: 0, cpuUsageUsec: 0 }
  for (const unit of [botSliceName(bot.slug), userSliceName(bot.uid)]) {
    const u = readCgroupUsage(unit, read)
    if (!u) continue
    usage.memoryBytes += u.memoryBytes
    usage.cpuUsageUsec += u.cpuUsageUsec
  }
  return usage
}

function disk(path: string): DiskStats | null {
  try {
    const s = statfsSync(path)
    return { path, totalBytes: s.blocks * s.bsize, usedBytes: (s.blocks - s.bfree) * s.bsize }
  } catch {
    return null
  }
}

export function readStats(bots: BotRef[]): GuestStats {
  return {
    at: Date.now(),
    uptimeSec: Math.round(os.uptime()),
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    cpu: parseProcStat(readText('/proc/stat')),
    memory: parseMeminfo(readText('/proc/meminfo')),
    disks: [disk('/'), disk('/data')].filter((d): d is DiskStats => d !== null),
    bots: bots.map((b) => ({ slug: b.slug, ...botUsage(b) })),
  }
}
