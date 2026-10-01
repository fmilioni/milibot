import type { DefaultAgentHost } from '@milibot/agent'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type { Message, Plan, PlanDetail, PlanPayload, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { FakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let provider: FakeProvider
let chiefDm: string
let guestState: FakeGuest['state']

const dir = useTempDir('plans')
afterEach(stopRuntimes)

async function boot(script: FakeStep[]) {
  h = await bootRuntime({ dir: dir(), script, fallback: { text: 'ok' }, host: { compaction: false } })
  ;({ runtime, host, events, provider, dm: chiefDm } = h)
  guestState = h.guest.state
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

function planCards(): Array<Message & { payload: PlanPayload }> {
  return runtime.store.messages
    .list(chiefDm, { limit: 200 })
    .messages.filter((m): m is Message & { payload: PlanPayload } => m.payload?.type === 'plan')
}

/** Tool results in the context of the model's last call. */
function toolResults(): string[] {
  return (provider.requests.at(-1)?.messages ?? []).flatMap((m) =>
    m.role === 'tool' ? m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])) : [],
  )
}

function lastInput(): string {
  const last = provider.requests.at(-1)?.messages.findLast((m) => m.role === 'user')
  return (last?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

const PLAN = {
  title: 'Refactor the login',
  summary: 'Swaps the session for tokens and covers the flow with tests.',
  body: '## Goal\nLogin with tokens.',
  execution: 'chat',
  steps: [{ title: 'Map routes' }, { title: 'Swap middleware' }],
}

describe('plans', () => {
  it('submits, is approved from the card route and executes until every step is done', async () => {
    await boot([
      { toolCalls: [{ name: 'plan_write', arguments: PLAN }] },
      { toolCalls: [{ name: 'plan_submit', arguments: { plan: 'Refactor the login' } }] },
      {
        toolCalls: [
          {
            name: 'todo_write',
            arguments: {
              todos: [
                { title: 'Map routes', status: 'done' },
                { title: 'Swap middleware', status: 'done', note: 'new middleware in src/auth.ts' },
              ],
            },
          },
        ],
      },
      { text: 'Done: login with tokens.' },
    ])
    await call(
      'postMessage',
      { conversationId: chiefDm },
      { content: 'plan and build the login with tokens' },
    )
    await until(() => planCards()[0]?.payload.status === 'awaiting_approval')
    const [card] = planCards()
    const plans = await call<Plan[]>('listPlans', {}, undefined, {})
    expect(plans).toHaveLength(1)
    const planId = card!.payload.planId
    expect(plans[0]).toMatchObject({ id: planId, status: 'awaiting_approval' })

    await call<Plan>('approvePlan', { planId }, {})
    await host.idle()
    expect(toolResults().some((r) => /approved the plan "Refactor the login"/.test(r))).toBe(true)
    const approval = toolResults().find((r) => /approved the plan/.test(r)) ?? ''
    expect(approval).toContain('gh pr create --draft')
    expect(approval).toContain('Do not merge the pull request')
    const detail = await call<PlanDetail>('getPlan', { planId })
    expect(detail.mergePr).toBeNull()
    expect(detail).toMatchObject({ status: 'done', revisions: [{ revision: 1, outcome: 'approved' }] })
    expect(detail.steps.map((s) => s.status)).toEqual(['done', 'done'])
    expect(detail.steps[1]?.note).toBe('new middleware in src/auth.ts')
    expect(planCards()[0]?.payload).toMatchObject({ status: 'done', steps: { done: 2, total: 2 } })
    expect(events.filter((e) => e.type === 'plan.updated').length).toBeGreaterThan(2)
    await expect(call('approvePlan', { planId }, {})).rejects.toThrow(/done/)
  })

  it('lets a plan approved with "merge the PR" merge it, and keeps the VM policy in line', async () => {
    await boot([
      { toolCalls: [{ name: 'plan_write', arguments: PLAN }] },
      { toolCalls: [{ name: 'plan_submit', arguments: { plan: 'Refactor the login' } }] },
      { text: 'I will carry it out.' },
    ])
    const policies = () =>
      guestState.execs
        .filter((e) => e.user === 'root' && String(e.cmd).includes('/etc/milibot/git-policy'))
        .map((e) => (e.env as Record<string, string>).POLICY)
    await until(() => policies().length > 0)
    expect(policies()[0]).toBe('DRAFT_PRS=1\nAUTO_MERGE=0\n')

    await call('postMessage', { conversationId: chiefDm }, { content: 'plan the login' })
    await until(() => planCards()[0]?.payload.status === 'awaiting_approval')
    const planId = planCards()[0]!.payload.planId
    await call<Plan>('approvePlan', { planId }, { mergePr: true })
    await host.idle()
    const approval = toolResults().find((r) => /approved the plan/.test(r)) ?? ''
    expect(approval).toContain('Merging is allowed here')
    expect((await call<PlanDetail>('getPlan', { planId })).mergePr).toBe(true)

    await call('updateWorkspacePreferences', {}, { autoMergePrs: true, draftPrs: false })
    await until(() => policies().includes('DRAFT_PRS=0\nAUTO_MERGE=1\n'))
  })

  it('asks for changes, gets a second revision, delivers a late decision as a new turn and deletes it', async () => {
    await boot([
      { toolCalls: [{ name: 'plan_write', arguments: PLAN }] },
      { toolCalls: [{ name: 'plan_submit', arguments: { plan: 'Refactor the login' } }] },
      {
        toolCalls: [
          {
            name: 'plan_write',
            arguments: { ...PLAN, plan: 'Refactor the login', body: '## Goal\nTokens, except admin.' },
          },
        ],
      },
      { toolCalls: [{ name: 'plan_submit', arguments: { plan: 'Refactor the login' } }] },
      { text: 'The plan is waiting for your approval.' },
      { text: 'Understood, I will not go ahead with it.' },
    ])
    await call('postMessage', { conversationId: chiefDm }, { content: 'plan the login with tokens' })
    await until(() => planCards()[0]?.payload.status === 'awaiting_approval')
    const planId = planCards()[0]!.payload.planId
    runtime.store.settings.set('bots.user_request_timeout_seconds', 0.05)
    await call<Plan>('requestPlanChanges', { planId }, { comment: 'Keep the session for admin' })
    await until(() => planCards()[1]?.payload.status === 'awaiting_approval')
    await host.idle()
    expect(toolResults().some((r) => r.includes('Keep the session for admin'))).toBe(true)
    expect(toolResults().some((r) => /not decided yet/.test(r))).toBe(true)
    expect(planCards().map((c) => [c.payload.revision, c.payload.status])).toEqual([
      [1, 'draft'],
      [2, 'awaiting_approval'],
    ])

    await call<Plan>('rejectPlan', { planId }, { comment: 'Not now' })
    await host.idle()
    expect(lastInput()).toMatch(/rejected the plan "Refactor the login": "Not now"/)
    const detail = await call<PlanDetail>('getPlan', { planId })
    expect(detail.revisions.map((r) => [r.revision, r.outcome])).toEqual([
      [1, 'changes_requested'],
      [2, 'rejected'],
    ])

    await call('deletePlan', { planId })
    expect(planCards().every((c) => c.payload.removed === true)).toBe(true)
    expect(await call<Plan[]>('listPlans', {}, undefined, {})).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'plan.deleted' })
  })
})
