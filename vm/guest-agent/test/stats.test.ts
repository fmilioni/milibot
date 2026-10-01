import { describe, expect, it } from 'vitest'

import {
  botUsage,
  parseFlatKeyed,
  parseMeminfo,
  parseProcStat,
  readCgroupUsage,
  sliceCgroupPath,
} from '../src/stats.ts'

const PROC_STAT = `cpu  4705 150 1120 16250 520 0 30 12 0 0
cpu0 1393 36 283 4125 134 0 17 3 0 0
intr 1234 0 0
`

const MEMINFO = `MemTotal:        8130212 kB
MemFree:          900000 kB
MemAvailable:    3200000 kB
Buffers:          100000 kB
Cached:          1500000 kB
SwapCached:            0 kB
Active(anon):    2000000 kB
SReclaimable:     200000 kB
HugePages_Total:       0
`

describe('guest stats parsers', () => {
  it('sums the aggregate cpu line, idle counting iowait', () => {
    expect(parseProcStat(PROC_STAT)).toEqual({
      totalTicks: 4705 + 150 + 1120 + 16250 + 520 + 0 + 30 + 12,
      idleTicks: 16250 + 520,
    })
  })

  it('uses MemAvailable (not MemFree) and counts reclaimable cache', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 8130212 * 1024,
      availableBytes: 3200000 * 1024,
      cacheBytes: (100000 + 1500000 + 200000) * 1024,
    })
  })

  it('parses cgroup key/value files', () => {
    expect(parseFlatKeyed('usage_usec 1500\nuser_usec 1000\nsystem_usec 500\n')).toEqual({
      usage_usec: 1500,
      user_usec: 1000,
      system_usec: 500,
    })
  })

  it('maps slice names to their nested cgroup directory', () => {
    expect(sliceCgroupPath('user-1601.slice')).toBe('user.slice/user-1601.slice')
    expect(sliceCgroupPath('milibot-bot-iris.slice')).toBe(
      'milibot.slice/milibot-bot.slice/milibot-bot-iris.slice',
    )
    expect(sliceCgroupPath('milibot-bot-code\\x2dreview.slice')).toBe(
      'milibot.slice/milibot-bot.slice/milibot-bot-code\\x2dreview.slice',
    )
  })
})

describe('bot usage', () => {
  const files: Record<string, string> = {
    '/sys/fs/cgroup/milibot.slice/milibot-bot.slice/milibot-bot-iris.slice/memory.current': '524288000\n',
    '/sys/fs/cgroup/milibot.slice/milibot-bot.slice/milibot-bot-iris.slice/memory.stat':
      'anon 400000000\nfile 124288000\ninactive_file 24288000\n',
    '/sys/fs/cgroup/milibot.slice/milibot-bot.slice/milibot-bot-iris.slice/cpu.stat':
      'usage_usec 9000000\nuser_usec 8000000\n',
    '/sys/fs/cgroup/user.slice/user-2001.slice/memory.current': '100000000\n',
    '/sys/fs/cgroup/user.slice/user-2001.slice/memory.stat': 'inactive_file 0\n',
    '/sys/fs/cgroup/user.slice/user-2001.slice/cpu.stat': 'usage_usec 1000000\n',
  }
  const read = (p: string): string => {
    const text = files[p]
    if (text === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
    return text
  }

  it('subtracts inactive page cache from memory.current', () => {
    expect(readCgroupUsage('milibot-bot-iris.slice', read)).toEqual({
      memoryBytes: 500_000_000,
      cpuUsageUsec: 9_000_000,
    })
  })

  it('adds the bot slice and the login slice', () => {
    expect(botUsage({ slug: 'iris', uid: 2001 }, read)).toEqual({
      memoryBytes: 600_000_000,
      cpuUsageUsec: 10_000_000,
    })
  })

  it('counts a missing slice (bot never logged in, slice not started) as zero', () => {
    expect(readCgroupUsage('milibot-bot-nova.slice', read)).toBeNull()
    expect(botUsage({ slug: 'nova', uid: 2002 }, read)).toEqual({ memoryBytes: 0, cpuUsageUsec: 0 })
  })
})
