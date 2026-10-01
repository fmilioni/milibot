import type { VmStats } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  botUsageRows,
  diskPercent,
  diskTotals,
  fullestDisk,
  historyBars,
  memoryPercent,
  peakCpu,
  percentOf,
  usageTone,
} from './vm-stats'

const GiB = 2 ** 30

function stats(overrides: Partial<VmStats> = {}): VmStats {
  return {
    at: 10_000,
    intervalSec: 5,
    uptimeSec: 3600,
    cpus: 4,
    loadavg: [1.5, 1, 0.5],
    cpuPercent: 38,
    memory: { totalBytes: 8 * GiB, usedBytes: 6 * GiB, cacheBytes: GiB },
    disks: {
      system: { usedBytes: 10 * GiB, totalBytes: 40 * GiB },
      data: { usedBytes: 54 * GiB, totalBytes: 60 * GiB },
    },
    bots: [
      { botId: 'bot_a', cpuPercent: 20, memoryBytes: GiB },
      { botId: 'bot_b', cpuPercent: 2, memoryBytes: 2 * GiB },
      { botId: 'bot_gone', cpuPercent: 9, memoryBytes: 3 * GiB },
    ],
    other: { cpuPercent: 7, memoryBytes: 3 * GiB },
    history: [
      { at: 5_000, cpuPercent: 90, memoryUsedBytes: 4 * GiB },
      { at: 10_000, cpuPercent: 38, memoryUsedBytes: 6 * GiB },
    ],
    ...overrides,
  }
}

describe('VM usage', () => {
  it('colors by threshold', () => {
    expect(usageTone(0)).toBe('success')
    expect(usageTone(74.9)).toBe('success')
    expect(usageTone(75)).toBe('warning')
    expect(usageTone(89.9)).toBe('warning')
    expect(usageTone(90)).toBe('danger')
  })

  it('computes percentages safely', () => {
    expect(percentOf(1, 4)).toBe(25)
    expect(percentOf(5, 0)).toBe(0)
    expect(percentOf(9, 4)).toBe(100)
    expect(memoryPercent(stats())).toBe(75)
    expect(diskPercent(null)).toBe(0)
    expect(diskPercent(stats().disks.data)).toBe(90)
  })

  it('sums both disks and warns about the fullest', () => {
    expect(diskTotals(stats())).toEqual({ usedBytes: 64 * GiB, totalBytes: 100 * GiB })
    expect(diskTotals(stats({ disks: { system: null, data: null } }))).toEqual({
      usedBytes: 0,
      totalBytes: 0,
    })
    expect(fullestDisk(stats())).toEqual({ disk: 'data', percent: 90 })
    expect(
      fullestDisk(stats({ disks: { system: { usedBytes: GiB, totalBytes: 40 * GiB }, data: null } })),
    ).toBeNull()
  })

  it('pads the chart so a fresh VM fills it from the right', () => {
    const cpu = historyBars(stats(), 'cpu')
    expect(cpu).toHaveLength(60)
    expect(cpu.slice(0, 58).every((v) => v === null)).toBe(true)
    expect(cpu.slice(58)).toEqual([0.9, 0.38])
    expect(historyBars(stats(), 'memory').slice(58)).toEqual([0.5, 0.75])
    expect(historyBars(stats({ intervalSec: 10 }), 'cpu')).toHaveLength(30)
    expect(peakCpu(stats())).toBe(90)
  })

  it('lists known bots, heaviest first, and "other" last', () => {
    expect(botUsageRows(stats(), new Set(['bot_a', 'bot_b']))).toEqual([
      { botId: 'bot_b', cpuPercent: 2, memoryBytes: 2 * GiB },
      { botId: 'bot_a', cpuPercent: 20, memoryBytes: GiB },
      { botId: null, cpuPercent: 7, memoryBytes: 3 * GiB },
    ])
  })
})
