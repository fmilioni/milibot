import type { ToolExecContext, TurnRequest } from '@milibot/agent'
import { FakeEmbeddingProvider } from '@milibot/agent/embeddings'
import type { Bot, PlanPayload, VmInfo, WorkspaceEvent } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { type Db } from '../../../src/db/sqlite'
import { EmbeddingService } from '../../../src/runtime/embeddings/service'
import { knowledgeCorpus } from '../../../src/runtime/knowledge/corpus'
import { KnowledgeService } from '../../../src/runtime/knowledge/service'
import { KnowledgeStore } from '../../../src/runtime/knowledge/store'
import { MemoryStore } from '../../../src/runtime/memory/store'
import { PlanService } from '../../../src/runtime/plans/service'
import { PlanTools } from '../../../src/runtime/plans/tools'
import { ProjectService } from '../../../src/runtime/projects/service'
import { ProviderStore } from '../../../src/runtime/providers/store'
import { TodoStore } from '../../../src/runtime/todos/store'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { MemorySecretStore } from '../../../src/secrets/secret-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { testProviders } from '../../support/providers'

let db: Db
let clock: number

beforeEach(() => {
  db = openWorkspaceDb(':memory:')
  clock = 1_000
})

const now = () => clock++

function setup() {
  const store = new WorkspaceStore(db, now)
  const memory = new MemoryStore(db, now)
  const chief = store.bots.create({ name: 'Chief' })
  const nina = store.bots.create({ name: 'Nina', label: 'Dev' })
  const dm = store.conversations.create({ type: 'direct', botIds: [chief.id] })
  store.conversations.create({ type: 'direct', botIds: [nina.id] })
  const events: WorkspaceEvent[] = []
  const turns: TurnRequest[] = []
  const docs = new KnowledgeStore(db, now)
  const knowledge = new KnowledgeService({
    docs,
    store,
    projects: {
      exists: (id): boolean => projects.find(id) !== null,
      ofConversation: (id): string | null => projects.current(id)?.id ?? null,
    },
    workspaceDir: '/nonexistent/milibot-test',
    vm: {
      status: () => ({ state: 'stopped', desktops: 0 }) as unknown as VmInfo,
      runningGuest: () => {
        throw new Error('VM not running')
      },
      subscribe: () => () => undefined,
    } as unknown as ConstructorParameters<typeof KnowledgeService>[0]['vm'],
    host: { writeText: async () => ({ text: 'Summary.', llmCallId: null }) },
    providers: new ProviderStore({ db, workspaceId: 'ws', secrets: new MemorySecretStore() }),
    catalog: testProviders(db).catalog,
    attachments: {
      get: () => {
        throw new Error('no attachments')
      },
      stagedFile: () => null,
      maxFileMb: () => 50,
    },
    emit: () => undefined,
    embeddings: new EmbeddingService({
      chunks: knowledgeCorpus(docs),
      getSetting: (key, fallback) => store.settings.get(key, fallback),
      setSetting: (key, value) => store.settings.set(key, value),
      createProvider: async () => new FakeEmbeddingProvider({ key: 'fake:test' }),
      now,
      log: () => undefined,
    }),
    modelsDir: null,
    now,
  })
  const projects = new ProjectService({
    db,
    store,
    emit: (event) => events.push(event),
    appendMessage: (message) => store.messages.create(message),
    now,
    knowledgeCatalog: () => '',
    projectNotes: (projectId) => memory.projectNotes(projectId).map((n) => n.content),
  })
  const stepLists = new TodoStore(db, now)
  const cardConversation = (bot: Bot, conversationId: string | null) =>
    conversationId ?? store.conversations.findDirect(bot.id)?.id ?? ''
  const plans = new PlanService({
    db,
    store,
    todos: stepLists,
    host: { enqueueTurn: (request) => turns.push(request) },
    embeddings: knowledge.embeddings,
    cardConversation,
    appendMessage: (message) => store.messages.create(message),
    updateMessage: (id, patch) => {
      store.messages.update(id, patch)
      return store.messages.get(id)
    },
    emit: (event) => events.push(event),
    now,
  })
  const tools = new PlanTools({ plans, todos: stepLists, store, projects, cardConversation })
  const ctx = (bot: Bot, conversationId: string | null = dm.id, detach = true): ToolExecContext => ({
    bot,
    conversationId,
    turnId: 'trn_1',
    signal: new AbortController().signal,
    ...(detach ? { detach: <T>(wait: Promise<T>) => wait } : {}),
  })
  const call = async (bot: Bot, name: string, args: Record<string, unknown>, conversationId = dm.id) => {
    const result = await tools.execute(ctx(bot, conversationId), { id: 't', name, arguments: args })
    return {
      text: result.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
      isError: result.isError ?? false,
    }
  }
  const card = (messageId: string | null | undefined) =>
    store.messages.get(messageId as string).payload as PlanPayload
  return { store, knowledge, projects, plans, tools, chief, nina, dm, events, turns, call, card }
}

const PLAN = {
  title: 'Refactor the login',
  summary: 'Swaps the session for tokens and covers the flow with tests.',
  body: '## Goal\nLogin with tokens.',
  execution: 'chat',
  steps: [{ title: 'Map routes' }, { title: 'Swap middleware', detail: 'src/auth.ts' }, { title: 'Tests' }],
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 2))
}

describe('PlanService', () => {
  it('writes a draft in the current project and only lets its author rewrite it while it is a draft', async () => {
    const { plans, projects, chief, nina, dm, call } = setup()
    const shop = projects.create({ name: 'Shop', description: '', repos: [] })
    projects.setCurrent(dm.id, shop.id, { type: 'user' })
    const written = await call(chief, 'plan_write', PLAN)
    expect(written.isError).toBe(false)
    const [plan] = plans.list()
    expect(plan).toMatchObject({
      status: 'draft',
      projectId: shop.id,
      execution: 'chat',
      revision: 1,
      conversationId: dm.id,
    })
    expect(plan?.steps.map((s) => [s.title, s.status])).toEqual([
      ['Map routes', 'pending'],
      ['Swap middleware', 'pending'],
      ['Tests', 'pending'],
    ])
    const rewritten = await call(chief, 'plan_write', { ...PLAN, plan: plan?.id, title: 'Login with tokens' })
    expect(rewritten.isError).toBe(false)
    expect(plans.get(plan!.id).title).toBe('Login with tokens')
    expect((await call(nina, 'plan_write', { ...PLAN, plan: plan?.id })).text).toMatch(/another bot/)
    expect((await call(chief, 'plan_write', { ...PLAN, summary: '' })).text).toMatch(/summary/)
  })

  it('submits with a card, waits for approval and tracks the steps until the plan is done', async () => {
    const { plans, chief, call, card, events } = setup()
    await call(chief, 'plan_write', PLAN)
    const id = plans.list()[0]!.id
    const submitted = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    const row = plans.detail(id)
    expect(row.revisions).toHaveLength(1)
    const messageId = (
      db.prepare('SELECT message_id FROM plans WHERE id = ?').get(id) as { message_id: string }
    ).message_id
    expect(card(messageId)).toMatchObject({ type: 'plan', status: 'awaiting_approval', revision: 1 })

    expect((await call(chief, 'todo_write', { todos: [{ title: 'x', status: 'done' }] })).text).toMatch(
      /no approved plan/,
    )
    plans.approve(id)
    const result = await submitted
    expect(result.text).toMatch(/approved the plan/)
    expect(result.text).toMatch(/todo_write/)
    expect(card(messageId).status).toBe('approved')

    const steps = plans.get(id).steps
    await call(chief, 'todo_write', {
      todos: [
        { id: steps[0]!.id, title: 'Map routes', status: 'done' },
        { title: 'Swap middleware', status: 'in_progress' },
        { title: 'Tests', status: 'pending' },
        { title: 'Update the docs', status: 'pending' },
      ],
    })
    let plan = plans.get(id)
    expect(plan.status).toBe('executing')
    expect(plan.steps.map((s) => s.id).slice(0, 3)).toEqual(steps.map((s) => s.id))
    expect(card(messageId).steps).toEqual({ done: 1, total: 4 })

    const done = await call(chief, 'todo_write', {
      todos: plan.steps.map((s, i) => ({ id: s.id, title: s.title, status: i === 3 ? 'skipped' : 'done' })),
    })
    expect(done.text).toMatch(/plan is finished/)
    plan = plans.get(id)
    expect(plan.status).toBe('done')
    expect(plan.finishedAt).not.toBeNull()
    expect(card(messageId)).toMatchObject({ status: 'done', steps: { done: 4, total: 4 } })
    expect(events.some((e) => e.type === 'plan.updated')).toBe(true)
  })

  it('revises a plan waiting for approval in place: the card shows it and the decision applies to it', async () => {
    const { plans, chief, call, card } = setup()
    await call(chief, 'plan_write', PLAN)
    const id = plans.list()[0]!.id
    const submitted = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    const revised = await call(chief, 'plan_write', {
      ...PLAN,
      plan: id,
      title: 'Login with tokens',
      steps: [{ title: 'Map routes' }, { title: 'Tests' }],
    })
    expect(revised.isError).toBe(false)
    expect(revised.text).toMatch(/Do not submit it again/)
    const detail = plans.detail(id)
    expect(detail).toMatchObject({ status: 'awaiting_approval', revision: 1, title: 'Login with tokens' })
    expect(detail.revisions).toHaveLength(1)
    expect(detail.revisions[0]).toMatchObject({ title: 'Login with tokens' })
    expect(detail.revisions[0]?.steps.map((s) => s.title)).toEqual(['Map routes', 'Tests'])
    const messageId = (
      db.prepare('SELECT message_id FROM plans WHERE id = ?').get(id) as { message_id: string }
    ).message_id
    expect(card(messageId)).toMatchObject({ title: 'Login with tokens', steps: { done: 0, total: 2 } })
    plans.approve(id)
    expect((await submitted).text).toMatch(/approved the plan/)
    expect((await call(chief, 'plan_write', { ...PLAN, plan: id })).text).toMatch(/todo_write/)
  })

  it('keeps the steps a partial todo_write leaves out and places new ones after the listed step', async () => {
    const { plans, chief, call } = setup()
    await call(chief, 'plan_write', PLAN)
    const id = plans.list()[0]!.id
    const submitted = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    plans.approve(id)
    await submitted
    const steps = plans.get(id).steps
    await call(chief, 'todo_write', {
      todos: [{ id: steps[0]!.id, title: steps[0]!.title, status: 'done', note: 'mapped' }],
    })
    await call(chief, 'todo_write', {
      todos: [
        { id: 'made-up', title: steps[0]!.title, status: 'done' },
        { title: 'Check the redirects', status: 'in_progress' },
      ],
    })
    const plan = plans.get(id)
    expect(plan.steps.map((s) => s.title)).toEqual([
      steps[0]!.title,
      'Check the redirects',
      ...steps.slice(1).map((s) => s.title),
    ])
    expect(plan.steps[0]).toMatchObject({ id: steps[0]!.id, status: 'done', note: 'mapped' })
    expect(plan.steps.slice(2).map((s) => s.id)).toEqual(steps.slice(1).map((s) => s.id))
    expect(plan.status).toBe('executing')
  })

  it('lets another bot mark one step of the plan it was asked to help with', async () => {
    const { plans, chief, nina, call } = setup()
    await call(chief, 'plan_write', PLAN)
    const id = plans.list()[0]!.id
    const submitted = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    plans.approve(id)
    await submitted
    const [first, second] = plans.get(id).steps
    expect(plans.activePlan(chief, chief.id, plans.get(id).conversationId)).toMatchObject({ id })

    const started = await call(nina, 'plan_step', { plan: id, step: first!.id, status: 'in_progress' })
    expect(started.isError).toBeFalsy()
    const done = await call(nina, 'plan_step', {
      plan: id,
      step: first!.title.toUpperCase(),
      status: 'done',
      note: 'done on the branch',
    })
    expect(done.isError).toBeFalsy()
    const plan = plans.get(id)
    expect(plan.status).toBe('executing')
    expect(plan.steps[0]).toMatchObject({ status: 'done', note: 'done on the branch' })
    expect(plan.steps[1]).toMatchObject({ id: second!.id, status: 'pending' })
    expect((await call(nina, 'plan_step', { plan: id, step: 'none of these', status: 'done' })).isError).toBe(
      true,
    )
  })

  it('keeps revisions: asking for changes returns the comment and the next submission is revision 2', async () => {
    const { plans, chief, call, card } = setup()
    await call(chief, 'plan_write', PLAN)
    const id = plans.list()[0]!.id
    const first = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    plans.requestChanges(id, 'Keep the session for the admin')
    expect((await first).text).toMatch(/Keep the session for the admin/)
    const firstCard = plans.detail(id)
    expect(firstCard).toMatchObject({
      status: 'draft',
      revision: 2,
      feedback: 'Keep the session for the admin',
    })
    expect(firstCard.revisions[0]).toMatchObject({ revision: 1, outcome: 'changes_requested' })

    await call(chief, 'plan_write', { ...PLAN, plan: id, body: '## Goal\nTokens, except admin.' })
    const second = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    const revisions = plans.detail(id).revisions
    expect(revisions.map((r) => r.revision)).toEqual([1, 2])
    const cards = db
      .prepare('SELECT message_id FROM plan_revisions WHERE plan_id = ? ORDER BY revision')
      .all(id) as Array<{ message_id: string }>
    expect(card(cards[0]!.message_id)).toMatchObject({ status: 'draft', revision: 1 })
    expect(card(cards[1]!.message_id)).toMatchObject({ status: 'awaiting_approval', revision: 2 })
    plans.reject(id, 'Not now')
    expect((await second).text).toMatch(/rejected the plan.*Not now/)
    expect(plans.get(id).status).toBe('rejected')
    expect((await call(chief, 'plan_write', { ...PLAN, plan: id })).isError).toBe(true)
  })

  it('delivers a decision taken after the tool stopped waiting as a plan_decision turn', async () => {
    const { plans, tools, store, chief, dm, turns } = setup()
    store.settings.set('bots.user_request_timeout_seconds', 0.01)
    await tools.execute(
      { bot: chief, conversationId: dm.id, turnId: 't', signal: new AbortController().signal },
      { id: 'w', name: 'plan_write', arguments: PLAN },
    )
    const id = plans.list()[0]!.id
    const result = await tools.execute(
      { bot: chief, conversationId: dm.id, turnId: 't', signal: new AbortController().signal },
      { id: 's', name: 'plan_submit', arguments: { plan: id } },
    )
    expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/not decided yet/) })
    plans.approve(id)
    expect(turns).toEqual([
      expect.objectContaining({
        botId: chief.id,
        conversationId: dm.id,
        trigger: 'plan_decision',
        note: expect.stringMatching(/approved the plan/),
      }),
    ])
  })

  it('marks every card removed on delete, hides the plan and refuses the routes on the wrong status', async () => {
    const { plans, chief, call, card, events } = setup()
    await call(chief, 'plan_write', PLAN)
    const id = plans.list()[0]!.id
    expect(() => plans.approve(id)).toThrow(/draft/)
    expect(() => plans.setStatus(id, 'done')).toThrow(/draft/)
    const submitted = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    const messageId = (
      db.prepare('SELECT message_id FROM plans WHERE id = ?').get(id) as { message_id: string }
    ).message_id
    plans.delete(id)
    expect((await submitted).text).toMatch(/deleted the plan/)
    expect(card(messageId).removed).toBe(true)
    expect(plans.list()).toEqual([])
    expect(() => plans.get(id)).toThrow(/not found/)
    expect(events.at(-1)).toEqual({ type: 'plan.deleted', payload: { planId: id } })
  })

  it('cancels an approved plan: todo_write then tells the bot to stop', async () => {
    const { plans, chief, call } = setup()
    await call(chief, 'plan_write', PLAN)
    const id = plans.list()[0]!.id
    const submitted = call(chief, 'plan_submit', { plan: id })
    await waitFor(() => plans.get(id).status === 'awaiting_approval')
    plans.approve(id)
    await submitted
    plans.setStatus(id, 'cancelled')
    const result = await call(chief, 'todo_write', {
      plan: id,
      todos: [{ title: 'Map routes', status: 'done' }],
    })
    expect(result).toMatchObject({ isError: true, text: expect.stringMatching(/stop working on it/) })
  })

  it('finds plans by text and by summary vector, within the project view', async () => {
    const { plans, projects, knowledge, chief, dm, call } = setup()
    const shop = projects.create({ name: 'Shop', description: '', repos: [] })
    const trip = projects.create({ name: 'Trip', description: '', repos: [] })
    await call(chief, 'plan_write', { ...PLAN, project: 'Shop' })
    await call(chief, 'plan_write', {
      title: 'Lisbon itinerary',
      summary: 'Hotels, tours and trains for five days in Lisbon.',
      body: 'x',
      steps: [{ title: 'Book a hotel' }],
      project: 'Trip',
    })
    await knowledge.embeddings.whenIdle()
    for (
      let i = 0;
      i < 50 && (db.prepare('SELECT COUNT(*) AS n FROM plan_vectors').get() as { n: number }).n < 2;
      i++
    )
      await new Promise((r) => setTimeout(r, 5))
    expect((db.prepare('SELECT COUNT(*) AS n FROM plan_vectors').get() as { n: number }).n).toBe(2)

    projects.setCurrent(dm.id, shop.id, { type: 'user' })
    const inShop = await call(chief, 'plan_search', { query: 'Lisbon hotels' })
    expect(inShop.text).not.toMatch(/Lisbon/)
    const everywhere = await call(chief, 'plan_search', { query: 'Lisbon hotels', project: 'all' })
    expect(everywhere.text).toMatch(/Lisbon itinerary/)
    const listed = await call(chief, 'plan_search', { project: 'Trip' })
    expect(listed.text).toMatch(/Lisbon itinerary/)
    expect(listed.text).not.toMatch(/login/i)
    expect(plans.list({ q: 'lisbon' }).map((p) => p.title)).toEqual(['Lisbon itinerary'])
    expect(plans.list({ projectId: trip.id })).toHaveLength(1)
    expect(plans.list({ projectId: 'general' })).toHaveLength(0)

    const vector = await knowledge.embeddings.queryVector('Lisbon itinerary', {
      timeoutMs: 1000,
      loadModel: true,
    })
    expect(vector).not.toBeNull()
    const found = await plans.search('Lisbon itinerary', { mode: 'any' }, null)
    expect(found[0]?.title).toBe('Lisbon itinerary')
  })
})
