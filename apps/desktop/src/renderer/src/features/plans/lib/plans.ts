import {
  foldText,
  type LineDiff,
  lineDiff,
  type Plan,
  type PlanRevision,
  type PlanStatus,
  type TodoStatus,
} from '@milibot/shared'

export interface PlanFilters {
  status?: PlanStatus
  /** A project id, or `general`. */
  projectId?: string
  botId?: string
  q?: string
}

/** A plan pushed by an event belongs in the filtered list (the text filter is checked on title and summary). */
export function planMatchesFilters(plan: Plan, filters: PlanFilters): boolean {
  if (filters.status && plan.status !== filters.status) return false
  if (filters.botId && plan.botId !== filters.botId) return false
  if (filters.projectId === 'general' && plan.projectId !== null) return false
  if (filters.projectId && filters.projectId !== 'general' && plan.projectId !== filters.projectId)
    return false
  const q = filters.q?.trim()
  if (q && !foldText(`${plan.title} ${plan.summary}`).includes(foldText(q))) return false
  return true
}

export type PlanTone = 'accent' | 'success' | 'danger' | 'muted' | 'warning'

export function planTone(status: PlanStatus): PlanTone {
  switch (status) {
    case 'awaiting_approval':
      return 'warning'
    case 'approved':
    case 'executing':
      return 'accent'
    case 'done':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'draft':
    case 'cancelled':
      return 'muted'
  }
}

/** What the user can do with a plan in its status. */
export function planActions(status: PlanStatus): { decide: boolean; finish: boolean } {
  return {
    decide: status === 'awaiting_approval',
    finish: status === 'approved' || status === 'executing',
  }
}

/** Body diff of a revision against the one before it (null for the first). */
export function revisionDiff(revisions: PlanRevision[], revision: number): LineDiff | null {
  const index = revisions.findIndex((r) => r.revision === revision)
  if (index <= 0) return null
  const before = revisions[index - 1] as PlanRevision
  const after = revisions[index] as PlanRevision
  const text = (r: PlanRevision) =>
    [`# ${r.title}`, '', r.body, '', ...r.steps.map((s, i) => `${i + 1}. ${s.title}`)].join('\n')
  return lineDiff(text(before), text(after))
}

const CHECKBOX: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[ ]',
  done: '[x]',
  skipped: '[x]',
}

/** The plan as a markdown file: title, summary, body and steps (checked when done or skipped). */
export function planMarkdown(
  plan: {
    title: string
    summary: string
    body: string
    steps: { title: string; detail?: string | null; status?: TodoStatus; note?: string | null }[]
  },
  labels: { steps: string },
): string {
  const steps = plan.steps.map((s) => {
    const lines = [`- ${CHECKBOX[s.status ?? 'pending']} ${s.title}`]
    for (const extra of [s.detail, s.note]) {
      if (extra?.trim())
        lines.push(
          ...extra
            .trim()
            .split('\n')
            .map((l) => `  ${l}`),
        )
    }
    return lines.join('\n')
  })
  return [
    `# ${plan.title}`,
    plan.summary.trim() && `> ${plan.summary.trim().replace(/\n/g, '\n> ')}`,
    plan.body.trim(),
    steps.length > 0 && `## ${labels.steps}\n\n${steps.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n')
}
