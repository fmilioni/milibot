import type { ToolExecContext } from '@milibot/agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RoutineService } from '../../../src/runtime/routines/service'
import { RoutineTools } from '../../../src/runtime/routines/tools'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const now = local(2026, 9, 26, 7, 0)

let store: WorkspaceStore
let service: RoutineService
let tools: RoutineTools
let botId: string
let dmId: string

beforeEach(() => {
  store = new WorkspaceStore(openWorkspaceDb(':memory:'), () => now)
  const bot = store.bots.create({ name: 'Analyst' })
  botId = bot.id
  dmId = store.conversations.create({ type: 'direct', botIds: [bot.id] }).id
  const appendMessage = (message: Parameters<typeof store.messages.create>[0]) =>
    store.messages.create(message)
  service = new RoutineService({
    db: store.db,
    store,
    host: { enqueueTurn: () => undefined },
    emit: () => undefined,
    appendMessage,
    now: () => now,
    catchUp: () => 'once',
    held: () => false,
    vmGate: () => 'run',
    bootVm: () => undefined,
    timers: { set: () => null, clear: () => undefined },
  })
  service.start()
  tools = new RoutineTools({ routines: service, store, appendMessage, now: () => now })
})

afterEach(() => service.stop())

// Portuguese on purpose: the schedules exercise the pt phrase parser
describe('routine tools', () => {
  const ctx = (): ToolExecContext => ({
    bot: store.bots.get(botId),
    conversationId: dmId,
    turnId: 'turn_1',
    signal: new AbortController().signal,
  })
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.execute(ctx(), { id: 'call_1', name, arguments: args })
    const content = result.content[0]
    return { error: result.isError === true, text: content?.type === 'text' ? content.text : '' }
  }

  it('creates a routine from plain words and posts the card', async () => {
    const result = await run('routine_create', {
      name: 'Close the previous month report',
      schedule: 'todo dia 1º às 08:00',
      prompt: 'Close the previous month report in /workspace/reports.',
    })
    expect(result.error).toBe(false)
    expect(result.text).toContain('on the 1st of every month at 08:00')
    expect(result.text).toContain('Next run: 2026-10-01 08:00')
    const [routine] = service.list(botId)
    expect(routine).toMatchObject({ cron: '0 8 1 * *', enabled: true, nextRunAt: local(2026, 10, 1, 8, 0) })
    const card = store.messages.list(dmId, { limit: 10 }).messages.at(-1)
    expect(card).toMatchObject({ kind: 'card', authorType: 'bot', authorBotId: botId })
    expect(card?.payload).toEqual({
      type: 'routine_created',
      routineId: routine?.id,
      botId,
      name: 'Close the previous month report',
      cron: '0 8 1 * *',
      nextRunAt: local(2026, 10, 1, 8, 0),
    })
  })

  it('refuses schedules it cannot understand, with examples', async () => {
    const vague = await run('routine_create', { name: 'X', schedule: 'de vez em quando', prompt: 'Do it.' })
    expect(vague.error).toBe(true)
    expect(vague.text).toMatch(/Could not understand .*"seg a sex 18:30"/)
    expect(
      (await run('routine_create', { name: 'X', schedule: '* * * * *', prompt: 'Do it.' })).text,
    ).toMatch(/too often/)
    expect((await run('routine_create', { name: 'X', prompt: 'Do it.' })).text).toMatch(
      /"schedule" is required/,
    )
    expect(
      (await run('routine_create', { name: '', schedule: 'todo dia 8h', prompt: 'Do it.' })).text,
    ).toMatch(/"name"/)
    expect(service.list()).toEqual([])
  })

  it('lists, updates, pauses and deletes by name', async () => {
    await run('routine_create', {
      name: 'Daily summary',
      schedule: 'seg a sex 18:30',
      prompt: 'Summarize the day.',
    })
    expect((await run('routine_list', {})).text).toMatch(/Daily summary \(rtn_.*Mon–Fri at 18:30/)
    const updated = await run('routine_update', { routine: 'summary', schedule: 'every day at 7pm' })
    expect(updated.text).toContain('every day at 19:00')
    expect((await run('routine_update', { routine: 'Daily summary', enabled: false })).text).toContain(
      '[paused]',
    )
    expect((await run('routine_update', { routine: 'nothing', enabled: true })).error).toBe(true)
    expect((await run('routine_update', { routine: 'Daily summary', schedule: 'nunca' })).error).toBe(true)
    expect((await run('routine_delete', { routine: 'Daily summary' })).text).toContain('deleted')
    expect(service.list()).toEqual([])
    const lines = store.messages
      .list(dmId, { limit: 20 })
      .messages.filter((m) => m.kind === 'system_event')
      .map((m) => (m.payload?.type === 'system' ? m.payload.event : null))
    expect(lines).toEqual(['routine_updated', 'routine_updated', 'routine_deleted'])
    expect((await run('routine_list', {})).text).toBe('You have no routines.')
  })
})
