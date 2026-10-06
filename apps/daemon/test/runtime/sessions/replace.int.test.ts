import type { ToolExecContext, ToolResult } from '@milibot/agent'
import type { Board, BoardCard, BoardDetail, Plan, WorkSession } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness

const dir = useTempDir('sessions-replace')
afterEach(stopRuntimes)

async function boot() {
  h = await bootRuntime({ dir: dir(), fallback: { text: 'ok' }, host: { compaction: false } })
}

function ctx(): ToolExecContext {
  const bot = h.store.bots.find(h.botId)
  if (!bot) throw new Error('no bot')
  return { bot, conversationId: h.dm, turnId: null, signal: new AbortController().signal }
}

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const result: ToolResult = await h.runtime.services.tools.execute(ctx(), {
    id: name,
    name,
    arguments: args,
  })
  return (result.content[0] as { text: string }).text
}

const sessions = () => h.call<WorkSession[]>('listWorkSessions', {}, undefined, {})
const byTitle = async (title: string) => (await sessions()).find((s) => s.title === title) as WorkSession

async function cards(): Promise<BoardCard[]> {
  const [board] = await h.call<Board[]>('listBoards', {}, undefined, {})
  return (await h.call<BoardDetail>('getBoard', { boardId: board!.id })).cards
}

describe('a new session for the same work', () => {
  it('closes the session of the same card left waiting, never one running or on another card', async () => {
    await boot()
    await tool('board_create', {
      title: 'Release',
      summary: 'S.',
      cards: [{ title: 'Review login' }, { title: 'Review export' }],
    })
    const [login, exported] = await cards()

    await tool('session_start', { title: 'Review login', goal: 'Review it.', card: login!.id })
    await tool('session_start', { title: 'Review export', goal: 'Review it.', card: exported!.id })
    await h.host.idle()
    expect((await byTitle('Review login')).status).toBe('idle')
    const lastMessage = h.store.conversations.get(
      (await byTitle('Review login')).conversationId,
    ).lastMessageAt
    expect(h.runtime.services.workSessions.openOf(h.botId)[0]).toMatchObject({
      title: 'Review login',
      idleSince: lastMessage,
    })

    const text = await tool('session_start', { title: 'Retest login', goal: 'Retest it.', card: login!.id })
    expect(text).toMatch(/It replaces "Review login" \(wses_\w+\), which was waiting on the same work/)
    const old = await byTitle('Review login')
    expect(old).toMatchObject({
      status: 'cancelled',
      resultSummary: 'Replaced by the work session "Retest login".',
    })
    expect(old.finishedAt).not.toBeNull()
    expect((await byTitle('Review export')).status).toBe('idle')

    await h.host.idle()
    const retest = await byTitle('Retest login')
    h.db.prepare("UPDATE work_sessions SET status = 'running' WHERE id = ?").run(retest.id)
    const again = await tool('session_start', { title: 'Retest again', goal: 'Retest it.', card: login!.id })
    expect(again).not.toMatch(/It replaces/)
    expect((await byTitle('Retest login')).status).toBe('running')
  })

  it('closes the waiting session of the same plan', async () => {
    await boot()
    await tool('plan_write', {
      title: 'Export',
      summary: 'Exports reports.',
      body: 'The plan.',
      steps: [{ title: 'Export' }],
    })
    const submitted = tool('plan_submit', { plan: 'Export' })
    await until(
      () => h.db.prepare("SELECT 1 FROM plans WHERE status = 'awaiting_approval'").get() !== undefined,
    )
    const [plan] = await h.call<Plan[]>('listPlans', {}, undefined, {})
    await h.call<Plan>('approvePlan', { planId: plan!.id }, { execution: 'session' })
    await submitted
    await until(async () => (await sessions()).length === 1)
    await h.host.idle()
    const first = await byTitle('Export')
    expect(first.status).toBe('idle')

    const text = await tool('session_start', { title: 'Export retest', goal: 'Retest.', plan: plan!.id })
    expect(text).toMatch(/It replaces "Export"/)
    expect((await byTitle('Export')).status).toBe('cancelled')
    const current = await byTitle('Export retest')
    expect(current.planId).toBe(plan!.id)
    expect((await h.call<Plan>('getPlan', { planId: plan!.id })).sessionId).toBe(current.id)
  })
})
