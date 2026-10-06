import type { ToolExecContext } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import type { VmDetails, VmStats } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { VmStatusTools } from '../../../src/runtime/observability/vm-status'

const GB = 1024 ** 3
const NOW = Date.parse('2026-10-06T12:00:00Z')
const me = makeBot({ id: 'bot_01ME', name: 'Theo' })
const names: Record<string, string> = { bot_01ME: 'Theo', bot_01LINA: 'Lina' }

function details(overrides: Partial<VmDetails> = {}): VmDetails {
  return {
    vm: {
      state: 'running',
      config: { cpus: 6, memGb: 12, dataGb: 60, systemGb: 40 },
      portBase: 47000,
      desktops: 2,
      system: { goldenVersion: '0.4.0', revision: 3, latestRevision: 4 },
    },
    running: { cpus: 4, memGb: 8 },
    startedAt: NOW - 125 * 60_000,
    pendingRestart: true,
    disks: {
      system: { virtualBytes: 40 * GB, actualBytes: 12 * GB },
      data: { virtualBytes: 60 * GB, actualBytes: null },
    },
    snapshots: [{ name: 'before-upgrade', createdAt: NOW - 86_400_000 }],
    workingBots: 1,
    task: null,
    systemUpdate: null,
    ...overrides,
  }
}

const stats: VmStats = {
  at: NOW,
  intervalSec: 5,
  uptimeSec: 7500,
  cpus: 4,
  loadavg: [1.2, 0.8, 0.5],
  cpuPercent: 37.4,
  memory: { totalBytes: 8 * GB, usedBytes: 5 * GB, cacheBytes: 1 * GB },
  disks: { system: { usedBytes: 10 * GB, totalBytes: 40 * GB }, data: null },
  bots: [
    { botId: 'bot_01LINA', cpuPercent: 3, memoryBytes: 300 * 1024 ** 2 },
    { botId: 'bot_01ME', cpuPercent: 20, memoryBytes: 2 * GB },
    { botId: 'bot_01GONE', cpuPercent: 1, memoryBytes: 3 * GB },
  ],
  other: { cpuPercent: 2, memoryBytes: 512 * 1024 ** 2 },
  history: [
    { at: NOW - 240_000, cpuPercent: 80, memoryUsedBytes: 4 * GB },
    { at: NOW, cpuPercent: 37.4, memoryUsedBytes: 5 * GB },
  ],
}

function tool(d: VmDetails, s: VmStats | null) {
  const provider = new VmStatusTools({
    admin: { details: async () => d },
    stats: { current: () => s },
    botName: (id) => names[id] ?? null,
    now: () => NOW,
  })
  const ctx: ToolExecContext = {
    bot: me,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  return {
    provider,
    async run() {
      const result = await provider.execute(ctx, { id: 'c1', name: 'vm_status', arguments: {} })
      expect(result.isError).toBeFalsy()
      return result.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    },
  }
}

describe('vm_status', () => {
  it('reports what the VM screen shows: state, resources, disks, image, restore points and usage per bot', async () => {
    const text = await tool(details(), stats).run()
    expect(text).toContain('State: running')
    expect(text).toContain('Running since 2026-10-06T09:55:00.000Z (2h 5m)')
    expect(text).toContain(
      'Resources: 4 CPUs, 8 GB memory (configured 6 CPUs, 12 GB memory: applies on the next restart)',
    )
    expect(text).toContain(
      'Disks: system 40.0 GB (12.0 GB used on the host); data 60.0 GB (size on the host unknown)',
    )
    expect(text).toContain('System image: revision 3 (0.4.0), a system update to revision 4 is available')
    expect(text).toContain('Bots working now: 1')
    expect(text).toContain('Restore points (1): before-upgrade (2026-10-05T12:00:00.000Z)')
    expect(text).toContain('- CPU 37% of 4 CPUs (load 1.20 0.80 0.50; peak 80% in the last 4m)')
    expect(text).toContain('- Memory 5.0 GB used of 8.0 GB (+1.0 GB cache)')
    expect(text).toContain('- Disks inside the VM: system 10.0 GB of 40.0 GB (25%); data unknown')
    // Heaviest first, the caller marked, deleted bots left out, "other" last.
    const rows = text.split('\n').filter((l) => l.startsWith('  - '))
    expect(rows).toEqual([
      '  - Theo (you): CPU 20%, memory 2.0 GB',
      '  - Lina: CPU 3%, memory 300 MB',
      '  - Other (Linux, services, Docker): CPU 2%, memory 512 MB',
    ])
  })

  it('reports a stopped VM with its configured resources and no usage', async () => {
    const stopped = details({
      vm: { ...details().vm, state: 'stopped' },
      running: null,
      startedAt: null,
      pendingRestart: false,
      snapshots: [],
      workingBots: 0,
    })
    const text = await tool(stopped, null).run()
    expect(text).toContain('State: stopped')
    expect(text).toContain('Resources (configured): 6 CPUs, 12 GB memory')
    expect(text).toContain('Restore points: none')
    expect(text).toContain('Usage: none (the VM is not running)')
    expect(text).not.toContain('Running since')
  })

  it('reports errors, the operation in progress and a pending system update', async () => {
    const failing = details({
      vm: { ...details().vm, state: 'error', error: 'port 47000 is taken', errorCode: 'PORT_IN_USE' },
      task: {
        kind: 'restart',
        status: 'waiting_idle',
        error: null,
        startedAt: NOW - 60_000,
        finishedAt: null,
      },
      systemUpdate: { status: 'waiting_golden', whenIdle: true, requestedAt: NOW - 120_000 },
    })
    const text = await tool(failing, null).run()
    expect(text).toContain('Error [PORT_IN_USE]: port 47000 is taken')
    expect(text).toContain(
      'VM operation: restart, waiting for the bots to be idle (started 2026-10-06T11:59:00.000Z)',
    )
    expect(text).toContain(
      'System update requested 2026-10-06T11:58:00.000Z: waiting for the new system image to be built, when the bots are idle',
    )
  })

  it('says when a running VM has no sample yet', async () => {
    expect(await tool(details(), null).run()).toContain('Usage: not sampled yet')
  })

  it('serves only the read, no VM action', () => {
    const { provider } = tool(details(), stats)
    expect(provider.handles('vm_status')).toBe(true)
    for (const action of ['vm_start', 'vm_stop', 'vm_restart', 'vm_reset', 'vm_snapshot']) {
      expect(provider.handles(action)).toBe(false)
    }
  })
})
