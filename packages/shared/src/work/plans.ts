import { z } from 'zod'

import { type Progress } from '../core/schemas'
import { endpoint, Ok } from '../http/endpoint'
import { ModelChoice } from '../models/reasoning'

/*
 * Plans: what a bot proposes before large work. The bot writes a plan (markdown body + steps + summary) and
 * submits it; the user approves, asks for changes or rejects it; approved, the bot executes it and keeps its
 * steps up to date, and the plan ends `done` when every step is done or skipped.
 */
export const PlanStatus = z.enum([
  'draft',
  'awaiting_approval',
  'approved',
  'executing',
  'done',
  'rejected',
  'cancelled',
])
export type PlanStatus = z.infer<typeof PlanStatus>

/** Where the approved plan runs: in the chat itself or in a work session (large work). */
export const PlanExecution = z.enum(['chat', 'session'])
export type PlanExecution = z.infer<typeof PlanExecution>

export const TodoStatus = z.enum(['pending', 'in_progress', 'done', 'skipped'])
export type TodoStatus = z.infer<typeof TodoStatus>

export const PlanStep = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  status: TodoStatus,
  /** What the bot noted about it (result, why it was skipped). */
  note: z.string().nullable(),
  updatedAt: z.number().int(),
})
export type PlanStep = z.infer<typeof PlanStep>

export const Plan = z.object({
  id: z.string(),
  botId: z.string(),
  projectId: z.string().nullable(),
  conversationId: z.string(),
  sessionId: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  revision: z.number().int(),
  execution: PlanExecution,
  /** Chosen on approval; null follows the workspace's `autoMergePrs`. */
  mergePr: z.boolean().nullable(),
  /** Model of the session that executes it; null = the bot's own model. */
  model: ModelChoice.nullable(),
  /** Absolute folder under /workspace its session works in when it has no repository; null = its own folder. */
  folder: z.string().nullable(),
  status: PlanStatus,
  /** The user's last comment (changes asked for, or why it was rejected). */
  feedback: z.string().nullable(),
  steps: z.array(PlanStep),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
})
export type Plan = z.infer<typeof Plan>

export const PlanRevisionOutcome = z.enum(['approved', 'changes_requested', 'rejected'])
export type PlanRevisionOutcome = z.infer<typeof PlanRevisionOutcome>

export const PlanRevision = z.object({
  revision: z.number().int(),
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  steps: z.array(z.object({ title: z.string(), detail: z.string().nullable() })),
  feedback: z.string().nullable(),
  outcome: PlanRevisionOutcome.nullable(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
})
export type PlanRevision = z.infer<typeof PlanRevision>

export const PlanDetail = Plan.extend({ revisions: z.array(PlanRevision) })
export type PlanDetail = z.infer<typeof PlanDetail>

export const ListPlansQuery = z.object({
  status: PlanStatus.optional(),
  /** A project id, or `general` for plans without a project. */
  projectId: z.string().optional(),
  botId: z.string().optional(),
  q: z.string().trim().max(200).optional(),
})
export type ListPlansQuery = z.input<typeof ListPlansQuery>

const ApprovePlanBody = z.object({
  execution: PlanExecution.optional(),
  mergePr: z.boolean().optional(),
  /** null = the bot's own model; absent = what the plan asked for. */
  model: ModelChoice.nullable().optional(),
})
const RequestPlanChangesBody = z.object({ comment: z.string().trim().min(1).max(4000) })
const RejectPlanBody = z.object({ comment: z.string().trim().max(4000).optional() })
/** For an approved or executing plan. */
const SetPlanStatusBody = z.object({ status: z.enum(['done', 'cancelled']) })

export const planEndpoints = {
  /** Newest first; deleted plans never appear. */
  listPlans: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/plans',
    query: ListPlansQuery,
    response: z.array(Plan),
  }),
  getPlan: endpoint({ method: 'GET', path: '/w/:workspaceId/plans/:planId', response: PlanDetail }),
  approvePlan: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/plans/:planId/approve',
    body: ApprovePlanBody,
    response: Plan,
  }),
  requestPlanChanges: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/plans/:planId/request-changes',
    body: RequestPlanChangesBody,
    response: Plan,
  }),
  rejectPlan: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/plans/:planId/reject',
    body: RejectPlanBody,
    response: Plan,
  }),
  setPlanStatus: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/plans/:planId/status',
    body: SetPlanStatusBody,
    response: Plan,
  }),
  /** Soft delete: the plan leaves every list and its chat cards say it was removed. */
  deletePlan: endpoint({ method: 'DELETE', path: '/w/:workspaceId/plans/:planId', response: Ok }),
}

/** Steps done or skipped. */
export function planProgress(steps: Array<Pick<PlanStep, 'status'>>): Progress {
  return {
    done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
  }
}
