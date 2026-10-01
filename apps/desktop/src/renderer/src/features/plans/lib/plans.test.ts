import type { Plan, PlanRevision } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { planActions, planMarkdown, planMatchesFilters, revisionDiff } from './plans'

const plan = (patch: Partial<Plan> = {}): Plan => ({
  id: 'plan_1',
  botId: 'bot_1',
  projectId: null,
  conversationId: 'cnv_1',
  sessionId: null,
  title: 'Lisbon itinerary',
  summary: 'Hotels and cafés',
  body: '',
  revision: 1,
  execution: 'chat',
  mergePr: null,
  folder: null,
  model: null,
  status: 'executing',
  feedback: null,
  steps: [],
  createdAt: 1,
  updatedAt: 1,
  decidedAt: null,
  finishedAt: null,
  ...patch,
})

const revision = (n: number, body: string, steps: string[]): PlanRevision => ({
  revision: n,
  title: 'Login',
  summary: '',
  body,
  steps: steps.map((title) => ({ title, detail: null })),
  feedback: null,
  outcome: null,
  createdAt: n,
  decidedAt: null,
})

describe('plans', () => {
  it('matches events against the list filters', () => {
    expect(planMatchesFilters(plan(), {})).toBe(true)
    expect(planMatchesFilters(plan(), { status: 'done' })).toBe(false)
    expect(planMatchesFilters(plan(), { projectId: 'general' })).toBe(true)
    expect(planMatchesFilters(plan({ projectId: 'prj_1' }), { projectId: 'general' })).toBe(false)
    expect(planMatchesFilters(plan({ projectId: 'prj_1' }), { projectId: 'prj_1' })).toBe(true)
    expect(planMatchesFilters(plan(), { q: 'cafes' })).toBe(true)
    expect(planMatchesFilters(plan(), { q: 'Porto' })).toBe(false)
    expect(planMatchesFilters(plan(), { botId: 'bot_2' })).toBe(false)
  })

  it('offers the decision while waiting and finishing while running', () => {
    expect(planActions('awaiting_approval')).toEqual({ decide: true, finish: false })
    expect(planActions('executing')).toEqual({ decide: false, finish: true })
    expect(planActions('done')).toEqual({ decide: false, finish: false })
  })

  it('diffs a revision against the previous one (text and steps)', () => {
    const revisions = [
      revision(1, 'Tokens.', ['Routes']),
      revision(2, 'Tokens, except admin.', ['Routes', 'Tests']),
    ]
    expect(revisionDiff(revisions, 1)).toBeNull()
    const diff = revisionDiff(revisions, 2)
    expect(diff?.diff).toContain('-Tokens.')
    expect(diff?.diff).toContain('+Tokens, except admin.')
    expect(diff?.diff).toContain('+2. Tests')
    expect(diff).toMatchObject({ added: 2, removed: 1 })
  })

  it('writes the plan as markdown with its steps as a checklist', () => {
    const text = planMarkdown(
      {
        title: 'Itinerary',
        summary: 'Hotels\nand tours',
        body: '## Goal\nTravel.',
        steps: [
          { title: 'Book hotel', detail: 'Alfama', status: 'done', note: 'Done' },
          { title: 'Buy tickets', detail: null, status: 'in_progress', note: null },
        ],
      },
      { steps: 'Steps' },
    )
    expect(text).toBe(
      '# Itinerary\n\n> Hotels\n> and tours\n\n## Goal\nTravel.\n\n## Steps\n\n' +
        '- [x] Book hotel\n  Alfama\n  Done\n- [ ] Buy tickets\n',
    )
    expect(planMarkdown({ title: 'Title only', summary: '', body: '', steps: [] }, { steps: 'Steps' })).toBe(
      '# Title only\n',
    )
  })
})
