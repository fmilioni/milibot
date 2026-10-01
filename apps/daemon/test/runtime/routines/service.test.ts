import type { TurnOutcome, TurnRequest } from '@milibot/agent'
import type { RoutineCatchUp, WorkspaceEvent } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RoutineService, type Timers } from '../../../src/runtime/routines/service'
import type { VmGate } from '../../../src/runtime/routines/vm-gate'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

/** Timers driven by a fake clock: `advance` fires due callbacks in time order. */
class FakeClock implements Timers {
  private pending: Array<{ fn: () => void; at: number }> = []
  constructor(public now: number) {}
  set(fn: () => void, ms: number): unknown {
    const timer = { fn, at: this.now + ms }
    this.pending.push(timer)
    return timer
  }
  clear(handle: unknown): void {
    this.pending = this.pending.filter((t) => t !== handle)
  }
  advanceTo(end: number): void {
    for (;;) {
      const next = [...this.pending].sort((a, b) => a.at - b.at)[0]
      if (!next || next.at > end) break
      this.pending = this.pending.filter((t) => t !== next)
      this.now = Math.max(this.now, next.at)
      next.fn()
    }
    this.now = end
  }
}

let store: WorkspaceStore
let clock: FakeClock
let turns: TurnRequest[]
let events: WorkspaceEvent[]
let gate: VmGate
let held: boolean
let catchUp: RoutineCatchUp
let boots: number
let service: RoutineService
let botId: string
let dmId: string

function createService(): RoutineService {
  return new RoutineService({
    db: store.db,
    store,
    host: { enqueueTurn: (request) => turns.push(request) },
    emit: (event) => events.push(event),
    appendMessage: (message) => store.messages.create(message),
    now: () => clock.now,
    catchUp: () => catchUp,
    held: () => held,
    vmGate: () => gate,
    bootVm: () => {
      boots++
    },
    timers: clock,
  })
}

beforeEach(() => {
  const db = openWorkspaceDb(':memory:')
  clock = new FakeClock(local(2026, 9, 26, 7, 0))
  store = new WorkspaceStore(db, () => clock.now)
  const bot = store.bots.create({ name: 'Analyst' })
  botId = bot.id
  dmId = store.conversations.create({ type: 'direct', botIds: [bot.id] }).id
  turns = []
  events = []
  gate = 'run'
  held = false
  catchUp = 'once'
  boots = 0
  service = createService()
  service.start()
})

afterEach(() => service.stop())

const routineLines = () =>
  store.messages
    .list(dmId, { limit: 50 })
    .messages.filter((m) => m.kind === 'card' && m.payload?.type === 'routine_run')

const finish = (i: number, outcome: TurnOutcome) => turns[i]?.onFinished?.(outcome)

describe('RoutineService scheduler', () => {
  it('fires at the local time, posts the run card, runs a routine turn and records the outcome', () => {
    const routine = service.create(botId, {
      name: 'Report',
      prompt: 'Close the daily report.',
      cron: '0 8 * * *',
    })
    expect(routine.nextRunAt).toBe(local(2026, 9, 26, 8, 0))

    clock.advanceTo(local(2026, 9, 26, 7, 59))
    expect(turns).toHaveLength(0)
    clock.advanceTo(local(2026, 9, 26, 8, 0))
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ botId, conversationId: dmId, trigger: 'routine', routineId: routine.id })
    expect(turns[0]?.note).toBeUndefined()
    const [card] = routineLines()
    expect(card).toMatchObject({ authorType: 'system', kind: 'card' })
    expect(card?.payload).toEqual({
      type: 'routine_run',
      routineId: routine.id,
      botId,
      name: 'Report',
      prompt: 'Close the daily report.',
      late: false,
      manual: false,
    })
    expect(card?.content).toContain('Routine "Report" (every day at 08:00) ran at 2026-09-26 08:00')
    expect(card?.content).toMatch(/Routine instructions:\nClose the daily report\.$/)
    expect(card?.content).not.toContain('runs late')
    expect(service.get(routine.id)).toMatchObject({
      lastStatus: 'running',
      lastRunAt: local(2026, 9, 26, 8, 0),
      nextRunAt: local(2026, 9, 27, 8, 0),
    })

    finish(0, 'done')
    expect(service.get(routine.id).lastStatus).toBe('ok')
    clock.advanceTo(local(2026, 9, 27, 8, 0))
    expect(turns).toHaveLength(2)
    finish(1, 'error')
    expect(service.get(routine.id).lastStatus).toBe('error')
    expect(events.filter((e) => e.type === 'routine.updated').length).toBeGreaterThan(3)
  })

  it('does not stack runs while one is still going', () => {
    const routine = service.create(botId, { name: 'Check', prompt: 'Check it.', cron: '*/5 * * * *' })
    clock.advanceTo(local(2026, 9, 26, 7, 5))
    clock.advanceTo(local(2026, 9, 26, 7, 15))
    expect(turns).toHaveLength(1)
    finish(0, 'done')
    clock.advanceTo(local(2026, 9, 26, 7, 20))
    expect(turns).toHaveLength(2)
    expect(service.get(routine.id).nextRunAt).toBe(local(2026, 9, 26, 7, 25))
  })

  it('runs a missed routine once when the app comes back ("once")', () => {
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    service.stop()
    clock.now = local(2026, 9, 29, 10, 0)
    service = createService()
    service.start()
    expect(turns).toHaveLength(1)
    expect(routineLines().at(-1)?.content).toMatch(/was due at 2026-09-26 08:00 .*runs late now/)
    expect(routineLines().at(-1)?.payload).toMatchObject({ late: true })
    expect(service.get(routine.id).nextRunAt).toBe(local(2026, 9, 30, 8, 0))
  })

  it('skips a missed routine with the "skip" setting', () => {
    catchUp = 'skip'
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    service.stop()
    clock.now = local(2026, 9, 26, 9, 30)
    service = createService()
    service.start()
    expect(turns).toHaveLength(0)
    expect(service.get(routine.id)).toMatchObject({
      lastStatus: 'skipped',
      nextRunAt: local(2026, 9, 27, 8, 0),
    })
  })

  it('treats a timer that fires long after its time (Mac asleep) as missed', () => {
    catchUp = 'skip'
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    clock.now = local(2026, 9, 26, 11, 0)
    service.tick()
    expect(turns).toHaveLength(0)
    expect(service.get(routine.id).lastStatus).toBe('skipped')
  })

  it('marks a run cut by a runtime restart as interrupted', () => {
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    clock.advanceTo(local(2026, 9, 26, 8, 0))
    service.stop()
    service = createService()
    service.start()
    expect(service.get(routine.id).lastStatus).toBe('interrupted')
  })

  it('waits for a suspended VM and runs when it is back; boots a VM kept running', () => {
    gate = 'wait'
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    clock.advanceTo(local(2026, 9, 26, 8, 0))
    expect(turns).toHaveLength(0)
    expect(service.get(routine.id).lastStatus).toBe('waiting')

    clock.advanceTo(local(2026, 9, 26, 9, 0))
    expect(turns).toHaveLength(0)
    gate = 'run'
    service.tick()
    expect(turns).toHaveLength(1)
    expect(routineLines().at(-1)?.content).toContain('runs late')
    finish(0, 'done')

    gate = 'boot'
    clock.advanceTo(local(2026, 9, 27, 8, 0))
    expect(turns).toHaveLength(2)
    expect(boots).toBe(1)
  })

  it('holds runs while the spend limit pauses the bots', () => {
    held = true
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    clock.advanceTo(local(2026, 9, 26, 8, 0))
    expect(service.get(routine.id).lastStatus).toBe('waiting')
    held = false
    clock.advanceTo(local(2026, 9, 26, 8, 1))
    expect(turns).toHaveLength(1)
  })

  it('"run now" boots the VM if needed and is refused while bots are paused by the spend limit', () => {
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 1 * *' })
    gate = 'wait'
    expect(service.runNow(routine.id).lastStatus).toBe('running')
    expect(boots).toBe(1)
    expect(turns).toHaveLength(1)
    expect(() => service.runNow(routine.id)).toThrow(/already running/)
    finish(0, 'cancelled')
    expect(service.get(routine.id).lastStatus).toBe('cancelled')
    held = true
    expect(() => service.runNow(routine.id)).toThrow(/spend limit/)
  })

  it('pausing clears the next run; turning it back on schedules it again', () => {
    const routine = service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    expect(service.update(routine.id, { enabled: false }).nextRunAt).toBeNull()
    clock.advanceTo(local(2026, 9, 26, 8, 30))
    expect(turns).toHaveLength(0)
    expect(service.update(routine.id, { enabled: true }).nextRunAt).toBe(local(2026, 9, 27, 8, 0))
    expect(service.update(routine.id, { cron: '30 18 * * 1-5' }).nextRunAt).toBe(local(2026, 9, 28, 18, 30))
  })

  it("a deleted bot's routines go with it", () => {
    service.create(botId, { name: 'Report', prompt: 'Do it.', cron: '0 8 * * *' })
    service.botDeleted(botId)
    expect(service.list()).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'routine.deleted' })
  })
})
