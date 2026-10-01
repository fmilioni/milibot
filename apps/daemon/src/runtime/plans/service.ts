import { type AgentHost, type NewAgentMessage, type ToolExecContext } from '@milibot/agent'
import { ToolInputError } from '@milibot/agent/tools'
import {
  type Bot,
  DEFAULT_USER_REQUEST_TIMEOUT_SECONDS,
  inProjectView,
  type ListPlansQuery,
  type LogFn,
  type Message,
  type MessagePayload,
  type ModelChoice,
  newId,
  type Plan,
  type PlanDetail,
  type planEndpoints,
  type PlanExecution,
  type PlanPayload,
  planProgress,
  type PlanRevision,
  type PlanStatus,
  type ProjectView,
  type TodoStatus,
  USER_REQUEST_TIMEOUT_KEY,
  type WorkspaceEvent,
} from '@milibot/shared'

import { modelSpecJson, parseModelSpec } from '../../db/model-spec'
import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { EmbeddingService } from '../embeddings'
import type { TodoStore } from '../todos'
import { resolveByRef, stopped } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { PLAN_CORPUS, planCorpus, searchPlanIds } from './search'
import { type NewPlan, type PlanRow, PlanStore } from './store'

export type { PlanRow } from './store'

export type Decision =
  | { status: 'approved'; execution: PlanExecution }
  | { status: 'changes_requested'; comment: string }
  | { status: 'rejected'; comment: string | null }
  | { status: 'deleted' }

interface Waiter {
  resolve(decision: Decision): void
  reject(err: Error): void
}

export interface PlanServiceDeps {
  db: Db
  store: WorkspaceStore
  todos: TodoStore
  host: Pick<AgentHost, 'enqueueTurn'>
  embeddings: EmbeddingService
  /** The bot's current chat, else its DM (`GroupService.cardConversation`). */
  cardConversation: (bot: Bot, conversationId: string | null) => string
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  emit: (event: WorkspaceEvent) => void
  now: () => number
  /** Pull request rules for an approved plan (drafts, and whether it may merge). */
  pullRequestNote?: (plan: Plan) => string
  /** The work sessions (built after the plans, which they run). */
  sessions?: () => PlanSessions
  log?: LogFn
}

/** What plans need from work sessions (when they exist). */
export interface PlanSessions {
  /**
   * Starts the work session of a plan approved with execution "session"; returns what the approving tool
   * call tells the bot, or null when no session can run it (the plan then runs in the chat).
   */
  start(plan: Plan): { sessionId: string; text: string } | { error: string } | null
  /** The work session a lane belongs to, with the plan it executes. */
  sessionOf(laneKey: string | undefined): { id: string; planId: string | null } | null
  /** Steps of the session (its plan's or its own) changed. */
  stepsChanged(sessionId: string): void
}

export const STATUS_TEXT: Record<PlanStatus, string> = {
  draft: 'a draft (not sent yet)',
  awaiting_approval: "waiting for the user's approval",
  approved: 'approved',
  executing: 'being executed',
  done: 'done',
  rejected: 'rejected by the user',
  cancelled: 'cancelled by the user',
}

/** Plans, their approval cards and step lists. */
export class PlanService {
  private readonly waiters = new Map<string, Waiter>()
  private readonly plans: PlanStore
  private readonly todos: TodoStore

  constructor(private readonly deps: PlanServiceDeps) {
    this.plans = new PlanStore(deps.db, deps.now)
    this.todos = deps.todos
    deps.embeddings.addCorpus(planCorpus(deps.db))
  }

  /** Plans a board card can link to, newest first. */
  linkTargets(): Array<{ id: string; title: string }> {
    return this.plans.linkTargets()
  }

  /** Work sessions run plans approved with execution "session" and own the step lists of their lanes. */
  get sessions(): PlanSessions | null {
    return this.deps.sessions?.() ?? null
  }

  stop(): void {
    for (const waiter of [...this.waiters.values()]) waiter.reject(stopped())
  }

  row(id: string): PlanRow | null {
    return this.plans.row(id)
  }

  requireRow(id: string): PlanRow {
    return this.plans.requireRow(id)
  }

  /** The plan runs in `sessionId` (approved with execution "session"). */
  attachSession(planId: string, sessionId: string): void {
    const row = this.row(planId)
    if (!row) return
    const attached = this.update(planId, { session_id: sessionId })
    this.syncCard(attached)
    this.emit(attached)
  }

  toPlan(row: PlanRow): Plan {
    return {
      id: row.id,
      botId: row.bot_id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      title: row.title,
      summary: row.summary,
      body: row.body,
      revision: row.revision,
      execution: row.execution,
      mergePr: row.merge_pr === null ? null : row.merge_pr === 1,
      model: parseModelSpec(row.model_spec),
      folder: row.folder,
      status: row.status,
      feedback: row.feedback,
      steps: this.todos.steps('plan', row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at,
      finishedAt: row.finished_at,
    }
  }

  get(id: string): Plan {
    return this.toPlan(this.requireRow(id))
  }

  detail(id: string): PlanDetail {
    return { ...this.get(id), revisions: this.plans.revisions(id) }
  }

  list(query: ListPlansQuery = {}): Plan[] {
    return this.plans.list(query).map((r) => this.toPlan(r))
  }

  update(id: string, patch: Partial<Omit<PlanRow, 'seq' | 'id'>>): PlanRow {
    return this.plans.update(id, patch)
  }

  /** Every step is done or skipped (no card sync or event: the caller does both). */
  markDone(id: string): PlanRow {
    return this.update(id, { status: 'done', finished_at: this.deps.now() })
  }

  /** A new draft written by a bot, with its steps. */
  createDraft(plan: Omit<NewPlan, 'id'>, steps: Array<{ title: string; detail: string | null }>): PlanRow {
    const row = this.plans.insertDraft({ ...plan, id: newId('plan') })
    this.todos.replace('plan', row.id, steps)
    return row
  }

  /** A draft goes to the user: its revision is recorded and its approval card posted. */
  submit(row: PlanRow, bot: Bot, turnId: string | null): PlanRow {
    this.plans.saveRevision(row, this.revisionSteps(row.id))
    const waiting = this.update(row.id, { status: 'awaiting_approval', feedback: null })
    const message = this.deps.appendMessage({
      conversationId: waiting.conversation_id,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'card',
      content: `Plan: ${waiting.title}\n${waiting.summary}`,
      payload: this.cardPayload(waiting, waiting.revision),
      turnId,
    })
    this.plans.setRevisionMessage(waiting.id, waiting.revision, message.id)
    const posted = this.update(waiting.id, { message_id: message.id })
    this.emit(posted)
    return posted
  }

  /** The plan as stored, also when the user deleted it meanwhile. */
  latestRow(id: string): PlanRow {
    return this.plans.rowWithDeleted(id) ?? this.plans.requireRow(id)
  }

  private revisionSteps(planId: string): Array<{ title: string; detail: string | null }> {
    return this.todos.rows('plan', planId).map((t) => ({ title: t.title, detail: t.detail }))
  }

  emit(row: PlanRow): Plan {
    const plan = this.toPlan(row)
    this.deps.emit({ type: 'plan.updated', payload: { plan } })
    return plan
  }

  cardPayload(row: PlanRow, revision: number): PlanPayload {
    return {
      type: 'plan',
      planId: row.id,
      botId: row.bot_id,
      title: row.title,
      summary: row.summary,
      revision,
      status: row.status,
      execution: row.execution,
      model: parseModelSpec(row.model_spec),
      steps: planProgress(this.todos.rows('plan', row.id)),
      feedback: row.feedback,
      sessionId: row.session_id,
    }
  }

  /** The latest card follows the plan's status and steps; older ones keep what they showed. */
  syncCard(row: PlanRow): void {
    if (!row.message_id) return
    try {
      const payload = this.deps.store.messages.payload(row.message_id) as PlanPayload | null
      if (payload?.type !== 'plan') return
      this.deps.updateMessage(row.message_id, {
        payload: {
          ...payload,
          status: row.status,
          execution: row.execution,
          steps: planProgress(this.todos.rows('plan', row.id)),
          feedback: row.feedback,
          sessionId: row.session_id,
        },
      })
    } catch (err) {
      this.deps.log?.('warn', 'plan card update failed', { planId: row.id, err: errorMessage(err) })
    }
  }

  /** A plan revised while it waits: the pending revision and its card show the new version. */
  reviseAwaiting(row: PlanRow): void {
    this.plans.reviseRevision(row, this.revisionSteps(row.id))
    if (!row.message_id) return
    this.deps.updateMessage(row.message_id, {
      content: `Plan: ${row.title}\n${row.summary}`,
      payload: this.cardPayload(row, row.revision),
    })
  }

  isWaiting(planId: string): boolean {
    return this.waiters.has(planId)
  }

  waitDecision(ctx: ToolExecContext, planId: string): Promise<Decision | 'timeout'> {
    const setting = this.deps.store.settings.get<number>(
      USER_REQUEST_TIMEOUT_KEY,
      DEFAULT_USER_REQUEST_TIMEOUT_SECONDS,
    )
    const seconds =
      typeof setting === 'number' && setting > 0 ? setting : DEFAULT_USER_REQUEST_TIMEOUT_SECONDS
    const wait = new Promise<Decision | 'timeout'>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        this.waiters.delete(planId)
      }
      const onAbort = () => {
        cleanup()
        reject(stopped())
      }
      const timer = setTimeout(
        () => {
          cleanup()
          resolve('timeout')
        },
        Math.max(10, seconds * 1000),
      )
      this.waiters.set(planId, {
        resolve: (decision) => {
          cleanup()
          resolve(decision)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal.aborted) onAbort()
    })
    return ctx.detach ? ctx.detach(wait) : wait
  }

  /** What the bot reads about the user's decision (tool result, or the note of a later turn). */
  decisionText(row: PlanRow, decision: Decision): string {
    const title = `"${row.title}"`
    switch (decision.status) {
      case 'approved': {
        const steps = this.todos
          .rows('plan', row.id)
          .map((t) => `- ${t.title} (${t.id})`)
          .join('\n')
        const pullRequests = this.deps.pullRequestNote?.(this.toPlan(row))
        const track =
          `Execute it now, following its steps, and keep them current with todo_write (plan: "${row.id}"; ` +
          `one step in_progress). Do not repeat the plan to the user; they just approved it.\n` +
          (row.folder ? `Work in the folder ${row.folder}.\n` : '') +
          `Steps:\n${steps}` +
          (pullRequests ? `\nPull requests:\n${pullRequests}` : '')
        if (decision.execution === 'session') {
          const started = this.sessions?.start(this.toPlan(row)) ?? null
          if (started && 'sessionId' in started) return `The user approved the plan ${title}. ${started.text}`
          return (
            `The user approved the plan ${title} to run in a work session, but ` +
            (started ? `its session could not start (${started.error})` : 'work sessions are not available') +
            `: execute it here in the chat. ${track}`
          )
        }
        return `The user approved the plan ${title}. ${track}`
      }
      case 'changes_requested':
        return (
          `The user asked for changes to the plan ${title}: "${decision.comment}". Rewrite it with plan_write ` +
          `(plan: "${row.id}") taking this into account, then send it again with plan_submit. Do not start the work yet.`
        )
      case 'rejected':
        return `The user rejected the plan ${title}${decision.comment ? `: "${decision.comment}"` : ''}. Do not execute it.`
      case 'deleted':
        return `The user deleted the plan ${title}. Do not execute it.`
    }
  }

  /** Hands the decision to the waiting plan_submit; after it stopped waiting the bot gets a new turn. */
  private deliver(row: PlanRow, decision: Decision): void {
    const waiter = this.waiters.get(row.id)
    if (waiter) {
      waiter.resolve(decision)
      return
    }
    if (!this.deps.store.bots.find(row.bot_id)) return
    this.deps.host.enqueueTurn({
      botId: row.bot_id,
      conversationId: row.conversation_id,
      trigger: 'plan_decision',
      note: `[Milibot] The user decided on the plan you submitted earlier (plan_submit). ${this.decisionText(row, decision)}`,
    })
  }

  private decideRevision(
    row: PlanRow,
    outcome: NonNullable<PlanRevision['outcome']>,
    feedback: string | null,
  ) {
    this.plans.decideRevision(row, outcome, feedback)
  }

  private requireAwaiting(row: PlanRow): void {
    if (row.status !== 'awaiting_approval')
      throw new DaemonError('conflict', `The plan is ${STATUS_TEXT[row.status]}`, { status: row.status })
  }

  /** `model` undefined keeps what the plan asked for; null = the bot's own model. */
  approve(id: string, execution?: PlanExecution, mergePr?: boolean, model?: ModelChoice | null): Plan {
    const current = this.requireRow(id)
    if (current.status === 'approved' || current.status === 'executing') return this.toPlan(current)
    this.requireAwaiting(current)
    const chosen = execution ?? current.execution
    this.decideRevision(current, 'approved', null)
    const row = this.update(id, {
      status: 'approved',
      execution: chosen,
      ...(mergePr !== undefined ? { merge_pr: mergePr ? 1 : 0 } : {}),
      ...(model !== undefined ? { model_spec: modelSpecJson(model) } : {}),
      feedback: null,
      decided_at: this.deps.now(),
    })
    this.syncCard(row)
    const plan = this.emit(row)
    this.deliver(row, { status: 'approved', execution: chosen })
    return plan
  }

  requestChanges(id: string, comment: string): Plan {
    const current = this.requireRow(id)
    this.requireAwaiting(current)
    this.decideRevision(current, 'changes_requested', comment)
    const decided = this.update(id, { status: 'draft', feedback: comment, decided_at: this.deps.now() })
    this.syncCard(decided)
    const row = this.update(id, { revision: current.revision + 1 })
    const plan = this.emit(row)
    this.deliver(row, { status: 'changes_requested', comment })
    return plan
  }

  reject(id: string, comment: string | null): Plan {
    const current = this.requireRow(id)
    this.requireAwaiting(current)
    this.decideRevision(current, 'rejected', comment)
    const row = this.update(id, {
      status: 'rejected',
      feedback: comment,
      decided_at: this.deps.now(),
      finished_at: this.deps.now(),
    })
    this.syncCard(row)
    const plan = this.emit(row)
    this.deliver(row, { status: 'rejected', comment })
    return plan
  }

  setStatus(id: string, status: 'done' | 'cancelled'): Plan {
    const current = this.requireRow(id)
    if (current.status === status) return this.toPlan(current)
    if (current.status !== 'approved' && current.status !== 'executing')
      throw new DaemonError('conflict', `The plan is ${STATUS_TEXT[current.status]}`, {
        status: current.status,
      })
    const row = this.update(id, { status, finished_at: this.deps.now() })
    this.syncCard(row)
    return this.emit(row)
  }

  delete(id: string): void {
    const row = this.requireRow(id)
    this.plans.softDelete(id)
    this.deps.embeddings.forgetCorpusItem(PLAN_CORPUS, id)
    for (const messageId of this.plans.cardMessageIds(row)) {
      try {
        const payload = this.deps.store.messages.payload(messageId) as PlanPayload | null
        if (payload?.type === 'plan')
          this.deps.updateMessage(messageId, { payload: { ...payload, removed: true } })
      } catch (err) {
        this.deps.log?.('warn', 'plan card update failed', { planId: id, err: errorMessage(err) })
      }
    }
    this.deps.emit({ type: 'plan.deleted', payload: { planId: id } })
    if (row.status === 'awaiting_approval') this.waiters.get(id)?.resolve({ status: 'deleted' })
  }

  reindex(id: string): void {
    void this.deps.embeddings
      .refreshCorpus(PLAN_CORPUS, [id])
      .catch((err: unknown) =>
        this.deps.log?.('warn', 'plan embedding failed', { planId: id, err: errorMessage(err) }),
      )
  }

  /** Plans matching `query` (full text + summary vectors, fused), best first. */
  async search(query: string, view: ProjectView, status: PlanStatus | null, limit = 10): Promise<Plan[]> {
    const rows = this.plans.withStatus(status).filter((r) => inProjectView(r.project_id, view))
    if (!rows.length) return []
    const byId = new Map(rows.map((r) => [r.id, r]))
    const ids = await searchPlanIds(this.deps, query, new Map(rows.map((r) => [r.seq, r.id])), limit)
    return ids.flatMap((id) => {
      const row = byId.get(id)
      return row ? [this.toPlan(row)] : []
    })
  }

  /** A plan the bot names in a tool (id or title). */
  resolve(bot: Bot, ref: string): Plan {
    return this.toPlan(this.resolveRow(bot, ref))
  }

  /** A plan by id or title: the bot's own first, then anyone's. */
  resolveRow(bot: Bot, ref: string): PlanRow {
    if (!ref) throw new ToolInputError('"plan" is required (its id or title)')
    const match = resolveByRef(this.plans.all(), ref, {
      id: (r) => r.id,
      names: (r) => [r.title],
      prefer: [(r) => r.bot_id === bot.id],
      ambiguous: { exact: 'first', partial: 'first' },
    })
    if (!('found' in match))
      throw new DaemonError('not_found', `There is no plan "${ref}" (plan_search lists them).`)
    return match.found
  }

  /**
   * What todo_write works on: the given plan; in a work session, its plan or else its own list; otherwise the
   * bot's approved plan in this conversation, else its latest.
   */
  todoTarget(ctx: ToolExecContext, ref: string): PlanRow | { sessionId: string } | null {
    if (ref) return this.resolveRow(ctx.bot, ref)
    const session = this.sessions?.sessionOf(ctx.laneKey) ?? null
    if (session) {
      const plan = session.planId ? this.row(session.planId) : null
      return plan ?? { sessionId: session.id }
    }
    const rows = this.plans.active(ctx.bot.id)
    let here: string | null = ctx.conversationId
    try {
      here = this.deps.cardConversation(ctx.bot, ctx.conversationId)
    } catch {
      // No conversation to match: the latest plan.
    }
    return rows.find((r) => r.conversation_id === here) ?? rows[0] ?? null
  }

  /** The approved plan a lane is carrying out (for requests it hands to other bots), with its steps. */
  activePlan(
    bot: Bot,
    laneKey: string,
    conversationId: string | null,
  ): { id: string; title: string; steps: Array<{ id: string; title: string; status: TodoStatus }> } | null {
    const session = this.sessions?.sessionOf(laneKey) ?? null
    const target = session ? null : this.todoTarget({ bot, laneKey, conversationId } as ToolExecContext, '')
    const row = session
      ? session.planId
        ? this.row(session.planId)
        : null
      : target && !('sessionId' in target)
        ? target
        : null
    if (!row || (row.status !== 'approved' && row.status !== 'executing')) return null
    return {
      id: row.id,
      title: row.title,
      steps: this.todos.rows('plan', row.id).map((t) => ({ id: t.id, title: t.title, status: t.status })),
    }
  }

  handlers(): EndpointHandlers<keyof typeof planEndpoints> {
    return {
      listPlans: ({ query }) => this.list(query),
      getPlan: ({ params }) => this.detail(params.planId),
      approvePlan: ({ params, body }) =>
        this.approve(params.planId, body.execution, body.mergePr, body.model),
      requestPlanChanges: ({ params, body }) => this.requestChanges(params.planId, body.comment),
      rejectPlan: ({ params, body }) => this.reject(params.planId, body.comment?.trim() || null),
      setPlanStatus: ({ params, body }) => this.setStatus(params.planId, body.status),
      deletePlan: ({ params }) => {
        this.delete(params.planId)
        return { ok: true as const }
      },
    }
  }
}
