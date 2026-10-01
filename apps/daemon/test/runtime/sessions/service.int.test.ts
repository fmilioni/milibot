import type { DefaultAgentHost } from '@milibot/agent'
import type { ChatMessage, CompletionRequest } from '@milibot/agent/llm'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type {
  Message,
  Plan,
  QuestionPayload,
  WorkSession,
  WorkSessionDetail,
  WorkSessionPayload,
  WorkspaceEvent,
} from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { Db } from '../../../src/db/sqlite'
import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { type FakeGuest, fakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
let db: Db
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let provider: FakeProvider
let guest: FakeGuest
let chiefDm: string

const dir = useTempDir('sessions')
afterEach(stopRuntimes)

function textOf(message: ChatMessage | undefined): string {
  return (message?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

/** The latest input of a request and how many tool results followed it. */
function lastInput(request: CompletionRequest): { text: string; tools: number; system: string } {
  const messages = request.messages
  const index = messages.findLastIndex((m) => m.role === 'user')
  return {
    text: textOf(messages[index]),
    tools: messages.slice(index + 1).filter((m) => m.role === 'tool').length,
    system: textOf(messages[0]),
  }
}

const inSession = (request: CompletionRequest) => lastInput(request).system.includes('# Work session')

async function boot(script: (request: CompletionRequest) => FakeStep, options: { fresh?: boolean } = {}) {
  const fake = fakeGuest()
  fake.state.execResult = (body) =>
    String(body.cmd).includes('git worktree')
      ? {
          code: 0,
          stdout: `STATUS=created\nBASE=main\nBRANCH=${String((body.env as Record<string, string>).BRANCH)}\n`,
          stderr: '',
        }
      : { code: 0, stdout: '', stderr: '' }
  h = await bootRuntime({
    dir: dir(),
    script,
    guest: fake,
    host: { compaction: false },
    ...(options.fresh === false ? { db } : {}),
  })
  ;({ db, runtime, host, events, provider, guest, dm: chiefDm } = h)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

const messagesOf = (conversationId: string): Message[] =>
  runtime.store.messages.list(conversationId, { limit: 200 }).messages

function sessionCard(): (Message & { payload: WorkSessionPayload }) | undefined {
  return messagesOf(chiefDm).find(
    (m): m is Message & { payload: WorkSessionPayload } => m.payload?.type === 'work_session',
  )
}

async function onlySession(): Promise<WorkSession> {
  await until(() => runtime.store.db.prepare('SELECT 1 FROM work_sessions').get() !== undefined)
  const [session] = await call<WorkSession[]>('listWorkSessions', {}, undefined, {})
  return session as WorkSession
}

describe('work sessions', () => {
  it('runs next to the chat, in its own worktree, and reports back where it started', async () => {
    let chatAnsweredWhileWorking = false
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (inSession(request)) {
        if (tools === 0)
          return { toolCalls: [{ name: 'bash', arguments: { command: 'make test' } }], delayMs: 150 }
        if (tools === 1)
          return {
            toolCalls: [
              { name: 'session_finish', arguments: { summary: 'Login with tokens done.', status: 'done' } },
            ],
          }
        return { text: 'Closed.' }
      }
      if (text.includes('Your work session')) return { text: 'The session finished: login with tokens done.' }
      if (text.includes('refactor the login') && tools === 0)
        return {
          toolCalls: [
            {
              name: 'session_start',
              arguments: { title: 'Refactor login', goal: 'Swap the session for tokens.', repo: 'app' },
            },
          ],
        }
      if (text.includes("how's the weather")) {
        chatAnsweredWhileWorking = sessionCard()?.payload.status !== 'done'
        return { text: 'Sunny.' }
      }
      return { text: 'I opened a session for that.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'refactor the login' })
    const session = await onlySession()
    expect(session).toMatchObject({
      title: 'Refactor login',
      repoName: 'app',
      originConversationId: chiefDm,
    })
    expect(session.cwd).toMatch(/^\/workspace\/worktrees\/app\/[a-z0-9-]+$/)
    await call('postMessage', { conversationId: chiefDm }, { content: "how's the weather?" })
    await host.idle()

    expect(chatAnsweredWhileWorking).toBe(true)
    const detail = await call<WorkSessionDetail>('getWorkSession', { sessionId: session.id })
    expect(detail).toMatchObject({ status: 'done', resultSummary: 'Login with tokens done.' })
    expect(detail.branch).toMatch(/^bot\/[a-z0-9-]+\/refactor-login-[a-z0-9]{8}$/)
    const conversation = runtime.store.conversations.get(session.conversationId)
    expect(conversation.type).toBe('session')
    expect(
      runtime.store.db
        .prepare('SELECT 1 FROM sidebar_items WHERE conversation_id = ?')
        .get(session.conversationId),
    ).toBeUndefined()
    const checkout = guest.state.execs.find((e) => String(e.cmd).includes('git worktree'))
    expect((checkout?.env as Record<string, string>).WT_PATH).toBe(session.cwd)
    const bash = guest.state.execs.find((e) => e.cmd === 'make test')
    expect(bash?.cwd).toBe(session.cwd)
    const worktree = runtime.store.db
      .prepare('SELECT session_id, worktree_path FROM repo_worktrees')
      .get() as { session_id: string; worktree_path: string }
    expect(worktree).toEqual({ session_id: session.id, worktree_path: session.cwd })
    expect(messagesOf(session.conversationId)[0]?.payload).toMatchObject({ type: 'session_brief' })

    const card = sessionCard()
    expect(card?.payload).toMatchObject({ status: 'done', resultSummary: 'Login with tokens done.' })
    expect(card?.content).toContain('Login with tokens done.')
    expect(messagesOf(chiefDm).at(-1)?.content).toBe('The session finished: login with tokens done.')
    const report = provider.requests.find((r) => lastInput(r).text.includes('Your work session'))
    expect(report && inSession(report)).toBe(false)
    expect(
      events.some((e) => e.type === 'work_session.updated' && e.payload.session.status === 'running'),
    ).toBe(true)
  })

  it("takes the user's messages and questions inside the session, and stops without stopping the chat", async () => {
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (inSession(request)) {
        if (text.includes('ask about the database') && tools > 0) return { text: 'Using Postgres.' }
        if (text.includes('ask about the database'))
          return {
            toolCalls: [
              {
                name: 'ask_user',
                arguments: {
                  questions: [
                    {
                      header: 'Database',
                      question: 'Which database?',
                      options: [{ label: 'Postgres' }, { label: 'SQLite' }],
                    },
                  ],
                },
              },
            ],
          }
        if (text.includes('work slowly')) return { text: 'ok', delayMs: 2_000 }
        return { text: 'In the session.' }
      }
      if (text.includes('open a session') && tools === 0)
        return {
          toolCalls: [
            { name: 'session_start', arguments: { title: 'Database', goal: 'Choose the database.' } },
          ],
        }
      return { text: 'No chat.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'open a session' })
    const session = await onlySession()
    await host.idle()
    expect(session.cwd).toMatch(/^\/workspace\/sessions\/[a-z0-9-]+-[a-z0-9]{8}$/)

    await call(
      'postMessage',
      { conversationId: session.conversationId },
      { content: 'ask about the database' },
    )
    await until(() => messagesOf(session.conversationId).some((m) => m.payload?.type === 'question'))
    const question = messagesOf(session.conversationId).find(
      (m): m is Message & { payload: QuestionPayload } => m.payload?.type === 'question',
    ) as Message & { payload: QuestionPayload }
    expect(messagesOf(chiefDm).some((m) => m.payload?.type === 'question')).toBe(false)
    await call(
      'answerQuestion',
      { requestId: question.payload.requestId },
      { answers: [{ selected: ['Postgres'] }] },
    )
    await host.idle()
    expect(messagesOf(session.conversationId).at(-1)?.content).toBe('Using Postgres.')
    const sessionRequests = provider.requests.filter(inSession)
    expect(sessionRequests.at(-1)?.messages.some((m) => m.role === 'tool')).toBe(true)

    await call('postMessage', { conversationId: session.conversationId }, { content: 'work slowly' })
    await until(
      () =>
        (runtime.store.db.prepare('SELECT status FROM work_sessions').get() as { status: string }).status ===
        'running',
    )
    await call('postMessage', { conversationId: chiefDm }, { content: 'hi' })
    const stopped = await call<WorkSession>('stopWorkSession', { sessionId: session.id })
    expect(stopped.status).toBe('cancelled')
    await host.idle()
    expect(messagesOf(chiefDm).at(-1)?.content).toBe('No chat.')
    expect(sessionCard()?.payload.status).toBe('cancelled')

    await expect(call('deleteWorkSession', { sessionId: 'wses_missing' })).rejects.toThrow()
    await call('deleteWorkSession', { sessionId: session.id })
    expect(sessionCard()?.payload.removed).toBe(true)
    expect(await call<WorkSession[]>('listWorkSessions', {}, undefined, {})).toEqual([])
  })

  it('runs a plan approved to execute in a session, tracking the steps there', async () => {
    const PLAN = {
      title: 'Migrate database',
      summary: 'Swaps SQLite for Postgres.',
      body: '## Goal\nPostgres.',
      steps: [{ title: 'Create schema' }, { title: 'Migrate data' }],
      execution: 'session',
    }
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (inSession(request)) {
        if (tools === 0)
          return {
            toolCalls: [
              {
                name: 'todo_write',
                arguments: {
                  todos: [
                    { title: 'Create schema', status: 'done' },
                    { title: 'Migrate data', status: 'done' },
                  ],
                },
              },
            ],
          }
        if (tools === 1)
          return {
            toolCalls: [{ name: 'session_finish', arguments: { summary: 'Migrated.', status: 'done' } }],
          }
        return { text: 'end' }
      }
      if (text.includes('plan the migration') && tools === 0)
        return { toolCalls: [{ name: 'plan_write', arguments: PLAN }] }
      if (text.includes('plan the migration') && tools === 1)
        return { toolCalls: [{ name: 'plan_submit', arguments: { plan: 'Migrate database' } }] }
      return { text: 'Right.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'plan the migration' })
    await until(
      () =>
        (runtime.store.db.prepare("SELECT 1 FROM plans WHERE status = 'awaiting_approval'").get() ?? null) !==
        null,
    )
    const [plan] = await call<Plan[]>('listPlans', {}, undefined, {})
    await call<Plan>('approvePlan', { planId: plan!.id }, { execution: 'session' })
    await host.idle()
    const session = await onlySession()
    expect(session.planId).toBe(plan!.id)
    const done = await call<Plan>('getPlan', { planId: plan!.id })
    expect(done).toMatchObject({ status: 'done', sessionId: session.id })
    expect(session.status).toBe('done')
    expect(session.steps).toEqual({ done: 2, total: 2 })
    expect(sessionCard()?.payload).toMatchObject({ planId: plan!.id, planConversationId: chiefDm })
    const planCard = messagesOf(chiefDm).find((m) => m.payload?.type === 'plan')
    expect(planCard?.payload).toMatchObject({ planId: plan!.id, sessionId: session.id })
    const chatTools = provider.requests
      .filter((r) => !inSession(r))
      .flatMap((r) => r.messages.filter((m) => m.role === 'tool').map(textOf))
    expect(chatTools.some((t) => t.includes('It runs in the work session'))).toBe(true)
  })

  it('lets the session of a plan approved with "merge the PR" merge it', async () => {
    const PLAN = {
      title: 'Fix build',
      summary: 'Fixes the build.',
      body: '## Goal\nGreen build.',
      steps: [{ title: 'Fix' }],
      execution: 'session',
    }
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (inSession(request)) {
        if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'gh pr merge 7' } }] }
        return { text: 'Merged.' }
      }
      if (text.includes('plan the build') && tools === 0)
        return { toolCalls: [{ name: 'plan_write', arguments: PLAN }] }
      if (text.includes('plan the build') && tools === 1)
        return { toolCalls: [{ name: 'plan_submit', arguments: { plan: 'Fix build' } }] }
      return { text: 'Right.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'plan the build' })
    await until(
      () =>
        (runtime.store.db.prepare("SELECT 1 FROM plans WHERE status = 'awaiting_approval'").get() ?? null) !==
        null,
    )
    const [plan] = await call<Plan[]>('listPlans', {}, undefined, {})
    await call<Plan>('approvePlan', { planId: plan!.id }, { execution: 'session', mergePr: true })
    await host.idle()
    const session = await onlySession()
    const brief = messagesOf(session.conversationId)[0]?.content ?? ''
    expect(brief).toContain('Merging is allowed here')
    const merge = guest.state.execs.find((e) => e.cmd === 'gh pr merge 7')
    expect((merge?.env as Record<string, string>).MILIBOT_ALLOW_MERGE).toBe('1')
    const cwd = runtime.store.db.prepare('SELECT cwd FROM work_sessions').get() as { cwd: string }
    await until(() =>
      guest.state.execs.some((e) =>
        String((e.env as Record<string, string> | undefined)?.POLICY ?? '').includes(
          `ALLOW_MERGE_DIR=${cwd.cwd}\n`,
        ),
      ),
    )
  })

  it('leaves sessions idle after a restart, until the user writes in them', async () => {
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (inSession(request)) return { text: 'ok', delayMs: 400 }
      if (text.includes('open a long session') && tools === 0)
        return {
          toolCalls: [{ name: 'session_start', arguments: { title: 'Long', goal: 'Long work.' } }],
        }
      return { text: 'Opened.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'open a long session' })
    const session = await onlySession()
    await until(
      () =>
        (runtime.store.db.prepare('SELECT status FROM work_sessions').get() as { status: string }).status ===
        'running',
    )
    await h.stop()
    // A runtime that died mid-turn leaves the session marked as running.
    db.prepare("UPDATE work_sessions SET status = 'running'").run()
    await boot(() => ({ text: 'Continuing.' }), { fresh: false })
    expect((await call<WorkSessionDetail>('getWorkSession', { sessionId: session.id })).status).toBe('idle')
    await call('postMessage', { conversationId: session.conversationId }, { content: 'continue' })
    await host.idle()
    expect(messagesOf(session.conversationId).at(-1)?.content).toBe('Continuing.')
  })

  it('opens a session on the model and effort the user asked for, next to a chat on its own model', async () => {
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (inSession(request))
        return tools === 0
          ? { toolCalls: [{ name: 'session_finish', arguments: { summary: 'Done.', status: 'done' } }] }
          : { text: 'Closed.' }
      if (text.includes('with big model') && tools === 0)
        return {
          toolCalls: [
            {
              name: 'session_start',
              arguments: {
                title: 'Big work',
                goal: 'Do it.',
                model: 'big model',
                effort: 'max',
                context: '64k',
              },
            },
          ],
        }
      return { text: 'Started.' }
    })
    const lab = await call<{ id: string }>(
      'createProvider',
      {},
      { type: 'openai_compatible', name: 'Lab', baseUrl: 'http://127.0.0.1:9/v1' },
    )
    await call(
      'createProviderModel',
      { providerId: lab.id },
      {
        modelId: 'lab/big-model',
        displayName: 'Big Model',
        contextWindow: 200_000,
        efforts: ['low', 'high'],
      },
    )
    await host.idle()
    await call('postMessage', { conversationId: chiefDm }, { content: 'do it with big model, effort max' })
    const session = await onlySession()
    expect(session.model).toMatchObject({
      providerId: lab.id,
      model: 'lab/big-model',
      effort: 'high',
      contextLimit: 64_000,
    })
    await until(() => provider.requests.some(inSession))
    await host.idle()
    const sessionRequest = provider.requests.find(inSession)
    expect(sessionRequest).toMatchObject({ model: 'lab/big-model', effort: 'high' })
    const chatRequest = provider.requests.find((r) => !inSession(r))
    expect(chatRequest?.model).not.toBe('lab/big-model')
    expect(chatRequest?.effort ?? null).toBeNull()
  })

  it('tells the bot what exists when the model it names is unknown', async () => {
    let answer = ''
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (tools > 0) {
        answer = textOf(request.messages.at(-1))
        return { text: 'Sorry.' }
      }
      if (text.includes('gemini'))
        return {
          toolCalls: [{ name: 'session_start', arguments: { title: 'X', goal: 'Y', model: 'gemini ultra' } }],
        }
      return { text: 'Ok.' }
    })
    await host.idle()
    await call('postMessage', { conversationId: chiefDm }, { content: 'use gemini' })
    await host.idle()
    expect(answer).toContain('No model matches "gemini ultra"')
    expect(runtime.store.db.prepare('SELECT 1 FROM work_sessions').get()).toBeUndefined()
  })
})
