import type { VmInfo } from '@milibot/shared'
import type { GuestStats } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  computeVmStats,
  STATS_FIRST_DELTA_MS,
  STATS_INTERVAL_MS,
  STATS_INTERVAL_SLOW_MS,
  VmStatsSampler,
} from '../../../src/runtime/vm/stats'

const GiB = 2 ** 30

function reading(at: number, overrides: Partial<GuestStats> = {}): GuestStats {
  return {
    at,
    uptimeSec: 3600,
    cpus: 4,
    loadavg: [1, 1, 1],
    cpu: { totalTicks: 0, idleTicks: 0 },
    memory: { totalBytes: 8 * GiB, availableBytes: 3 * GiB, cacheBytes: GiB },
    disks: [
      { path: '/', totalBytes: 40 * GiB, usedBytes: 11 * GiB },
      { path: '/data', totalBytes: 60 * GiB, usedBytes: 50 * GiB },
    ],
    bots: [],
    ...overrides,
  }
}

describe('computeVmStats', () => {
  it('turns counter deltas into VM and per-bot usage', () => {
    const prev = reading(0, {
      cpu: { totalTicks: 1000, idleTicks: 800 },
      bots: [
        { slug: 'iris', memoryBytes: GiB, cpuUsageUsec: 1_000_000 },
        { slug: 'gone', memoryBytes: GiB, cpuUsageUsec: 0 },
      ],
    })
    const cur = reading(5_000, {
      cpu: { totalTicks: 3000, idleTicks: 1800 },
      bots: [
        // 4 CPUs × 5 s = 20 s of CPU; 4 s used = 20%
        { slug: 'iris', memoryBytes: 2 * GiB, cpuUsageUsec: 5_000_000 },
        { slug: 'nova', memoryBytes: 0.5 * GiB, cpuUsageUsec: 3_000_000 },
        { slug: 'gone', memoryBytes: GiB, cpuUsageUsec: 9_000_000 },
      ],
    })
    const stats = computeVmStats(
      prev,
      cur,
      [
        { id: 'bot_iris', slug: 'iris' },
        { id: 'bot_nova', slug: 'nova' },
      ],
      [],
      5,
    )
    expect(stats.cpuPercent).toBe(50)
    expect(stats.memory).toEqual({ totalBytes: 8 * GiB, usedBytes: 5 * GiB, cacheBytes: GiB })
    expect(stats.disks).toEqual({
      system: { usedBytes: 11 * GiB, totalBytes: 40 * GiB },
      data: { usedBytes: 50 * GiB, totalBytes: 60 * GiB },
    })
    // nova has no previous reading: no CPU delta yet; `gone` is not a bot of the workspace anymore
    expect(stats.bots).toEqual([
      { botId: 'bot_iris', cpuPercent: 20, memoryBytes: 2 * GiB },
      { botId: 'bot_nova', cpuPercent: 0, memoryBytes: 0.5 * GiB },
    ])
    expect(stats.other).toEqual({ cpuPercent: 30, memoryBytes: 2.5 * GiB })
    expect(stats.history).toEqual([{ at: 5_000, cpuPercent: 50, memoryUsedBytes: 5 * GiB }])
  })

  it('never reports impossible values', () => {
    const prev = reading(1000, { cpu: { totalTicks: 100, idleTicks: 50 } })
    const same = computeVmStats(prev, reading(1000, { cpu: { totalTicks: 100, idleTicks: 50 } }), [], [], 5)
    expect(same.cpuPercent).toBe(0)
    const full = computeVmStats(
      prev,
      reading(2000, {
        cpu: { totalTicks: 200, idleTicks: 50 },
        bots: [{ slug: 'iris', memoryBytes: 9 * GiB, cpuUsageUsec: 1e12 }],
      }),
      [{ id: 'bot_iris', slug: 'iris' }],
      [],
      5,
    )
    expect(full.cpuPercent).toBe(100)
    expect(full.bots[0]?.cpuPercent).toBe(0)
    expect(full.other).toEqual({ cpuPercent: 100, memoryBytes: 0 })
  })
})

describe('VmStatsSampler', () => {
  let listener: ((info: VmInfo) => void) | null
  let state: VmInfo['state']
  let slow: boolean
  let readings: GuestStats[]
  let at: number
  let tick: number

  const info = (): VmInfo => ({
    state,
    config: { cpus: 4, memGb: 8, dataGb: 60, systemGb: 40 },
    portBase: 47000,
    desktops: 1,
  })
  const sampler = () => {
    const s = new VmStatsSampler({
      vm: {
        info,
        subscribe: (l) => {
          listener = l
          return () => (listener = null)
        },
        softwareEmulated: () => slow,
        runningGuest: () =>
          ({
            stats: async () => {
              at += 1000
              tick += 100
              const r = reading(at, { cpu: { totalTicks: tick, idleTicks: tick / 2 } })
              readings.push(r)
              return r
            },
          }) as never,
      },
      bots: () => [],
    })
    s.start()
    return s
  }
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    listener = null
    state = 'running'
    slow = false
    readings = []
    at = 0
    tick = 0
  })
  afterEach(() => vi.useRealTimers())

  it('reports once there are two readings, then samples at the interval', async () => {
    const s = sampler()
    await advance(0)
    expect(readings).toHaveLength(1)
    expect(s.current()).toBeNull()
    await advance(STATS_FIRST_DELTA_MS)
    expect(s.current()?.cpuPercent).toBe(50)
    expect(s.current()?.intervalSec).toBe(STATS_INTERVAL_MS / 1000)
    await advance(STATS_INTERVAL_MS - 1)
    expect(readings).toHaveLength(2)
    await advance(1)
    expect(readings).toHaveLength(3)
    s.close()
  })

  it('keeps five minutes of history', async () => {
    const s = sampler()
    await advance(STATS_FIRST_DELTA_MS + 100 * STATS_INTERVAL_MS)
    expect(s.current()?.history).toHaveLength(60)
    s.close()
  })

  it('samples less often under software emulation', async () => {
    slow = true
    const s = sampler()
    await advance(STATS_FIRST_DELTA_MS + 100 * STATS_INTERVAL_SLOW_MS)
    expect(s.current()?.history).toHaveLength(30)
    expect(s.current()?.intervalSec).toBe(10)
    s.close()
  })

  it('stops and forgets when the VM stops, and starts over when it runs again', async () => {
    const s = sampler()
    await advance(STATS_FIRST_DELTA_MS)
    expect(s.current()).not.toBeNull()
    state = 'stopped'
    listener?.(info())
    expect(s.current()).toBeNull()
    const count = readings.length
    await advance(10 * STATS_INTERVAL_MS)
    expect(readings).toHaveLength(count)
    state = 'running'
    listener?.(info())
    await advance(STATS_FIRST_DELTA_MS)
    expect(s.current()?.history).toHaveLength(1)
    s.close()
  })

  it('does nothing while the VM is not running', async () => {
    state = 'stopped'
    const s = sampler()
    await advance(10 * STATS_INTERVAL_MS)
    expect(readings).toHaveLength(0)
    s.close()
  })
})
