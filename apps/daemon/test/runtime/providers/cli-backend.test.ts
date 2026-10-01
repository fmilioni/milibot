import type { CliEngine, VmInfo } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { createCliBackend, killLabelledProcs } from '../../../src/runtime/providers/cli-backend'

function fakeGuest(labels: string[]) {
  const procs = labels.map((label, i) => ({ id: `old-${i}`, label, running: true }))
  const signals: string[] = []
  let failList = false
  const guest = {
    listProcs: async () => {
      if (failList) throw new Error('ECONNRESET')
      return { procs: [...procs] }
    },
    procSignal: async (id: string, signal: string) => {
      signals.push(`${id}:${signal}`)
      return { ok: true as const }
    },
    startProc: async (spec: { label: string }) => {
      const id = `new-${procs.length}`
      procs.push({ id, label: spec.label, running: true })
      return { id }
    },
  }
  const vm = {
    status: () => ({ state: 'running' }) as VmInfo,
    guest: async () => guest,
    runningGuest: () => guest,
  }
  return { guest, vm, signals, failNextList: (fail: boolean) => (failList = fail) }
}

const backendFor = (engine: CliEngine, t: ReturnType<typeof fakeGuest>) =>
  createCliBackend({ engine, vm: t.vm as never, store: {} as never, mcp: {} as never })

const spec = (label: string) => ({ user: 'agent', argv: ['claude'], cwd: '/', env: {}, display: 1, label })

describe('CLI process sweep', () => {
  it('stops what a previous runtime left of its own engine once, before the first process', async () => {
    const t = fakeGuest(['claude:ana', 'claude-summary:ana', 'codex:iris', 'browser:ana', 'login:claude'])
    const claude = backendFor('claude_code', t)
    await claude.startProcess(spec('claude:ana'))
    expect(t.signals).toEqual(['old-0:SIGTERM', 'old-1:SIGTERM'])

    await claude.startProcess(spec('claude:ana:internal'))
    await claude.sweepOrphans()
    expect(t.signals).toEqual(['old-0:SIGTERM', 'old-1:SIGTERM'])

    const codex = backendFor('codex', t)
    await codex.sweepOrphans()
    expect(t.signals.at(-1)).toBe('old-2:SIGTERM')
    expect(t.signals).toHaveLength(3)
  })

  it('retries a sweep that failed, but never once a process of its own started', async () => {
    const t = fakeGuest(['codex:iris'])
    const codex = backendFor('codex', t)
    t.failNextList(true)
    await codex.sweepOrphans()
    t.failNextList(false)
    await codex.sweepOrphans()
    expect(t.signals).toEqual(['old-0:SIGTERM'])

    const other = fakeGuest(['codex:iris'])
    const late = backendFor('codex', other)
    other.failNextList(true)
    await late.startProcess(spec('codex:iris'))
    other.failNextList(false)
    await late.startProcess(spec('codex:iris:internal'))
    expect(other.signals).toEqual([])
  })

  it('kills the processes still running after the grace period', async () => {
    const t = fakeGuest(['claude:ana', 'mcp:github'])
    expect(await killLabelledProcs(t.guest, ['claude:'], 10)).toBe(1)
    await new Promise((r) => setTimeout(r, 30))
    expect(t.signals).toEqual(['old-0:SIGTERM', 'old-0:SIGKILL'])
  })
})
