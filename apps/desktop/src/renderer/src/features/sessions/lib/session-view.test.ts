import type { Plan, PlanPayload, SessionChangedFile, WorkSession, WorkSessionPayload } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  activeWork,
  clampPanelWidth,
  filterChangedFiles,
  isSessionFinished,
  overlayPanelWidth,
  planSession,
  planShowsSession,
  sessionCardIsCompact,
  sessionMatchesFilters,
  sessionPanelCollapsed,
  sessionTone,
  shortFilePath,
  splitPath,
} from './session-view'

// Portuguese on purpose: an accented pt file name checks accent-insensitive filtering.

const session = (patch: Partial<WorkSession> = {}): WorkSession => ({
  id: 'wks_1',
  botId: 'bot_1',
  conversationId: 'cnv_s',
  originConversationId: 'cnv_1',
  originMessageId: null,
  planId: null,
  projectId: null,
  title: 'Refatorar auth',
  goal: 'Trocar o middleware',
  status: 'running',
  cwd: '/workspace/sessions/dev-1',
  repoName: null,
  branch: null,
  model: null,
  lane: { status: 'working', detail: 'bash' },
  steps: { done: 1, total: 3 },
  costUsd: 0.12,
  resultSummary: null,
  changes: null,
  createdAt: 1,
  updatedAt: 1,
  finishedAt: null,
  ...patch,
})

const file = (path: string, patch: Partial<SessionChangedFile> = {}): SessionChangedFile => ({
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
  ...patch,
})

describe('session view', () => {
  it('tells finished sessions and their tone', () => {
    expect(isSessionFinished('done')).toBe(true)
    expect(isSessionFinished('cancelled')).toBe(true)
    expect(isSessionFinished('idle')).toBe(false)
    expect(sessionTone('running')).toBe('accent')
    expect(sessionTone('failed')).toBe('danger')
  })

  it('filters sessions like the daemon', () => {
    expect(sessionMatchesFilters(session(), {})).toBe(true)
    expect(sessionMatchesFilters(session(), { status: 'done' })).toBe(false)
    expect(sessionMatchesFilters(session(), { botId: 'bot_2' })).toBe(false)
    expect(sessionMatchesFilters(session(), { projectId: 'general' })).toBe(true)
    expect(sessionMatchesFilters(session({ projectId: 'prj_1' }), { projectId: 'general' })).toBe(false)
    expect(sessionMatchesFilters(session({ projectId: 'prj_1' }), { projectId: 'prj_1' })).toBe(true)
  })

  it('filters changed files by any part of the path, accents and case aside', () => {
    const files = [
      file('src/b.ts'),
      file('src/Ação.ts'),
      file('docs/new.md', { status: 'renamed', oldPath: 'docs/old.md' }),
    ]
    expect(filterChangedFiles(files, '').map((f) => f.path)).toEqual([
      'docs/new.md',
      'src/Ação.ts',
      'src/b.ts',
    ])
    expect(filterChangedFiles(files, 'acao').map((f) => f.path)).toEqual(['src/Ação.ts'])
    expect(filterChangedFiles(files, 'old').map((f) => f.path)).toEqual(['docs/new.md'])
  })

  it('splits a path and keeps the panel width in range', () => {
    expect(splitPath('src/lib/a.ts')).toEqual({ name: 'a.ts', dir: 'src/lib' })
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' })
    expect(shortFilePath('/workspace/worktrees/app/ana/src/a.ts')).toBe('app/src/a.ts')
    expect(shortFilePath('/workspace/repos/app/src/a.ts')).toBe('app/src/a.ts')
    expect(shortFilePath('/workspace/sessions/ana-01h2/notes.md')).toBe('notes.md')
    expect(shortFilePath('/workspace/uploads/x.txt')).toBe('uploads/x.txt')
    expect(shortFilePath('/etc/hosts')).toBe('/etc/hosts')
    expect(clampPanelWidth(100, 1600)).toBe(360)
    expect(clampPanelWidth(2000, 1600)).toBe(1180)
    expect(clampPanelWidth(500, 800)).toBe(380)
    expect(clampPanelWidth(500, 600)).toBe(360)
  })

  it('collapses the plan/changes panel only without room for it and the conversation', () => {
    expect(sessionPanelCollapsed(779, false)).toBe(true)
    expect(sessionPanelCollapsed(780, false)).toBe(false)
    expect(sessionPanelCollapsed(1000, false)).toBe(false)
    expect(sessionPanelCollapsed(340, true)).toBe(false)
    expect(sessionPanelCollapsed(null, false)).toBe(false)
  })

  it('opens the collapsed panel 400px wide, leaving a strip of conversation, or over the whole column', () => {
    expect(overlayPanelWidth(779)).toBe(400)
    expect(overlayPanelWidth(680)).toBe(400)
    expect(overlayPanelWidth(420)).toBe(364)
    expect(overlayPanelWidth(376)).toBe(320)
    expect(overlayPanelWidth(375)).toBeNull()
    expect(overlayPanelWidth(320)).toBeNull()
  })
})

const plan = (patch: Partial<Plan> = {}): Plan =>
  ({
    id: 'plan_1',
    botId: 'bot_1',
    projectId: null,
    conversationId: 'cnv_1',
    sessionId: null,
    title: 'Migrar banco',
    summary: 'Postgres',
    body: '',
    revision: 1,
    execution: 'chat',
    mergePr: null,
    model: null,
    status: 'executing',
    feedback: null,
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    decidedAt: 1,
    finishedAt: null,
    folder: null,
    ...patch,
  }) as Plan

const planCard = (patch: Partial<PlanPayload> = {}): PlanPayload => ({
  type: 'plan',
  planId: 'plan_1',
  botId: 'bot_1',
  title: 'Migrar banco',
  summary: 'Postgres',
  revision: 1,
  status: 'executing',
  execution: 'session',
  steps: { done: 0, total: 2 },
  ...patch,
})

const sessionCard = (patch: Partial<WorkSessionPayload> = {}): WorkSessionPayload => ({
  type: 'work_session',
  sessionId: 'wks_1',
  botId: 'bot_1',
  title: 'Migrar banco',
  goal: 'Postgres',
  status: 'running',
  steps: { done: 0, total: 2 },
  ...patch,
})

describe('plans and their sessions', () => {
  it('follows the session only once a plan is approved to run in one', () => {
    expect(planShowsSession(planCard())).toBe(true)
    expect(planShowsSession(planCard({ status: 'done' }))).toBe(true)
    expect(planShowsSession(planCard({ status: 'awaiting_approval' }))).toBe(false)
    expect(planShowsSession(planCard({ status: 'rejected' }))).toBe(false)
    expect(planShowsSession(planCard({ execution: 'chat' }))).toBe(false)
    expect(planShowsSession(planCard({ removed: true }))).toBe(false)
  })

  it("finds the plan's session by the id on the card, else by the plan", () => {
    const other = session({ id: 'wks_2', botId: 'bot_2', planId: 'plan_1' })
    const sessions = { wks_2: other }
    expect(planSession(planCard({ sessionId: 'wks_2' }), sessions)).toBe(other)
    expect(planSession(planCard({ sessionId: 'wks_9' }), sessions)).toBeNull()
    expect(planSession(planCard(), sessions)).toBe(other)
    expect(planSession(planCard({ planId: 'plan_2' }), sessions)).toBeNull()
  })

  it('shrinks the session card only next to its plan card', () => {
    const withPlan = sessionCard({ planId: 'plan_1', planConversationId: 'cnv_1' })
    expect(sessionCardIsCompact(withPlan, 'cnv_1')).toBe(true)
    expect(sessionCardIsCompact(withPlan, 'cnv_other')).toBe(false)
    expect(sessionCardIsCompact(sessionCard(), 'cnv_1')).toBe(false)
    expect(sessionCardIsCompact({ ...withPlan, removed: true }, 'cnv_1')).toBe(false)
  })

  it('lists open sessions, then plans running in their chat, newest first', () => {
    const items = activeWork(
      [
        session({ id: 'wks_old', createdAt: 1 }),
        session({ id: 'wks_new', status: 'idle', createdAt: 5 }),
        session({ id: 'wks_done', status: 'done', createdAt: 9 }),
        session({ id: 'wks_prep', status: 'preparing', createdAt: 3 }),
      ],
      [
        plan({ id: 'plan_chat' }),
        plan({ id: 'plan_session', execution: 'session' }),
        plan({ id: 'plan_waiting', status: 'awaiting_approval' }),
        plan({ id: 'plan_newer', status: 'approved', decidedAt: 7 }),
      ],
    )
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'session:wks_new',
      'session:wks_prep',
      'session:wks_old',
      'plan:plan_newer',
      'plan:plan_chat',
    ])
  })
})
