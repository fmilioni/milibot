import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  projectViewArg,
  textArg,
  type ToolArgs,
  toolError,
  ToolInputError,
  toolText,
  trimmedString,
} from '@milibot/agent/tools'
import {
  type Bot,
  inProjectView,
  type PlanExecution,
  planProgress,
  PlanStatus,
  TodoStatus,
} from '@milibot/shared'

import { modelSpecJson } from '../../db/model-spec'
import { DaemonError } from '../../errors'
import type { BoardCardLinks } from '../boards'
import { sessionFolder } from '../files'
import type { ProjectService } from '../projects'
import { modelRequestArgs, modelRequestNote, type ModelRequests } from '../providers'
import { CHECKBOX, parseTodos, progressTail, type TodoStore } from '../todos'
import { oneLine, resolveByRef, type ToolHandlers, ToolSwitch } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { type PlanRow, type PlanService, STATUS_TEXT } from './service'

const MAX_STEPS = 40

export interface PlanToolsDeps {
  plans: PlanService
  todos: TodoStore
  store: WorkspaceStore
  projects: ProjectService
  /** The bot's current chat, else its DM (`GroupService.cardConversation`). */
  cardConversation: (bot: Bot, conversationId: string | null) => string
  /** Models a plan's session can be asked to run on. */
  models?: ModelRequests
  /** Board cards a plan can work on. */
  cards?: BoardCardLinks
}

/** The bots' plan tools (`plan_*`, `todo_write`). */
export class PlanTools extends ToolSwitch {
  readonly name = 'plans'
  protected readonly handlers: ToolHandlers = {
    plan_write: (ctx, a) => this.write(ctx, a),
    plan_submit: (ctx, a) => this.submit(ctx, a),
    todo_write: (ctx, a) => this.writeTodos(ctx, a),
    plan_step: (ctx, a) => this.markStep(ctx, a),
    plan_get: (ctx, a) => this.read(ctx, a),
    plan_search: (ctx, a) => this.searchTool(ctx, a),
  }
  private readonly plans: PlanService
  private readonly todos: TodoStore

  constructor(private readonly deps: PlanToolsDeps) {
    super()
    this.plans = deps.plans
    this.todos = deps.todos
  }

  private ownPlan(ctx: ToolExecContext, ref: string): PlanRow {
    const row = this.plans.resolveRow(ctx.bot, ref)
    if (row.bot_id !== ctx.bot.id) throw new DaemonError('conflict', `"${row.title}" is another bot's plan.`)
    return row
  }

  private cardId(ref: string): string {
    if (!this.deps.cards) throw new ToolInputError('boards are not available here')
    return this.deps.cards.resolveCardId(ref)
  }

  private parseSteps(value: unknown): Array<{ title: string; detail: string | null }> {
    if (!Array.isArray(value) || value.length === 0)
      throw new ToolInputError('"steps" must list 1 to 40 steps')
    if (value.length > MAX_STEPS) throw new ToolInputError(`at most ${MAX_STEPS} steps`)
    return value.map((raw, i) => {
      const s = (raw && typeof raw === 'object' ? raw : { title: raw }) as Record<string, unknown>
      const title = trimmedString(s.title).slice(0, 300)
      if (!title) throw new ToolInputError(`steps[${i}].title is empty`)
      const detail = trimmedString(s.detail).slice(0, 2000)
      return { title, detail: detail || null }
    })
  }

  private write(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const title = textArg(a, 'title', 120)
    const summary = textArg(a, 'summary', 1500)
    const body = textArg(a, 'body')
    if (!title) throw new ToolInputError('"title" is required')
    if (!summary) throw new ToolInputError('"summary" is required (2–4 sentences on what the plan does)')
    if (!body) throw new ToolInputError('"body" is required (the plan in markdown)')
    const steps = this.parseSteps(a.steps)
    const execution: PlanExecution = a.execution === 'chat' ? 'chat' : 'session'
    let projectId: string | null
    if (trimmedString(a.project)) {
      const found = this.deps.projects.resolve(trimmedString(a.project))
      if ('problem' in found) throw new ToolInputError(found.problem)
      projectId = 'project' in found ? found.project.id : null
    } else projectId = this.deps.projects.current(ctx.conversationId)?.id ?? null
    const asked = modelRequestArgs(a)
    const model = asked ? this.deps.models?.request(ctx.bot, asked, null) : null
    if (asked && !model) return toolError('Choosing a model for a plan is not available here.')
    if (model && !model.ok) return toolError(model.error)
    const modelSpec = model?.ok ? { model_spec: modelSpecJson(model.choice) } : {}
    const folder =
      a.folder === undefined || a.folder === null
        ? {}
        : { folder: trimmedString(a.folder) ? sessionFolder(trimmedString(a.folder)) : null }
    const cardId = trimmedString(a.card) ? this.cardId(trimmedString(a.card)) : null

    const existingRef = trimmedString(a.plan)
    let row: PlanRow
    if (existingRef) {
      const existing = this.ownPlan(ctx, existingRef)
      const waiting = existing.status === 'awaiting_approval'
      if (existing.status !== 'draft' && !waiting) {
        const hint =
          existing.status === 'approved' || existing.status === 'executing'
            ? ' Change its steps with todo_write.'
            : ' Write a new plan (omit "plan") for new work.'
        return toolError(`The plan "${existing.title}" is ${STATUS_TEXT[existing.status]}.${hint}`)
      }
      row = this.plans.update(existing.id, {
        title,
        summary,
        body,
        execution,
        project_id: projectId,
        ...modelSpec,
        ...folder,
      })
      this.todos.replace('plan', row.id, steps)
    } else {
      row = this.plans.createDraft(
        {
          botId: ctx.bot.id,
          projectId,
          conversationId: this.deps.cardConversation(ctx.bot, ctx.conversationId),
          title,
          summary,
          body,
          execution,
          modelSpec: modelSpec.model_spec ?? null,
          folder: folder.folder ?? null,
        },
        steps,
      )
    }
    if (row.status === 'awaiting_approval') this.plans.reviseAwaiting(row)
    this.plans.emit(row)
    this.plans.reindex(row.id)
    if (cardId) this.deps.cards?.linkPlan(cardId, { id: row.id, title: row.title })
    if (row.status === 'awaiting_approval')
      return toolText(
        `Plan "${row.title}" updated while it waits for the user (${row.id}, ${steps.length} steps): the card ` +
          'in the chat shows this version and the decision applies to it. Do not submit it again.',
        false,
        { detail: row.title },
      )
    return toolText(
      `Plan "${row.title}" saved as a draft (${row.id}, revision ${row.revision}, ${steps.length} steps). ` +
        `${model?.ok ? `${modelRequestNote(model)} ` : ''}Send it to the user with plan_submit.`,
      false,
      { detail: row.title },
    )
  }

  private async submit(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    let row = this.ownPlan(ctx, trimmedString(a.plan))
    if (this.plans.isWaiting(row.id)) return toolError('This plan is already waiting for the user.')
    if (row.status !== 'draft' && row.status !== 'awaiting_approval')
      return toolError(`The plan "${row.title}" is ${STATUS_TEXT[row.status]}; there is nothing to submit.`)
    if (row.status === 'draft') row = this.plans.submit(row, ctx.bot, ctx.turnId)
    const outcome = await this.plans.waitDecision(ctx, row.id)
    const latest = this.plans.latestRow(row.id)
    const activity = { detail: latest.title }
    if (outcome === 'timeout')
      return toolText(
        'The user has not decided yet. The plan card stays in the chat: when they decide you get a new turn ' +
          'with the decision. Do not start the planned work meanwhile; end your turn saying the plan is waiting ' +
          'for approval.',
        false,
        activity,
      )
    return toolText(this.plans.decisionText(latest, outcome), false, activity)
  }

  private writeTodos(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const target = this.plans.todoTarget(ctx, trimmedString(a.plan))
    if (!target)
      return toolText(
        'You have no approved plan to track and are not in a work session. Work that needs a step list is ' +
          'long work, and long work does not run in a chat: stop here and open a work session for it ' +
          '(plans-and-sessions skill), or propose a plan if the user should decide something first. A small ' +
          'task needs no step list: just do it.',
        true,
      )
    if ('sessionId' in target) {
      const steps = parseTodos(a.todos, this.todos.rows('session', target.sessionId))
      this.todos.replace('session', target.sessionId, steps)
      this.plans.sessions?.stepsChanged(target.sessionId)
      const progress = planProgress(steps)
      const tail = progressTail(
        steps,
        'Every step is done or skipped: finish the session with session_finish.',
      )
      return toolText(
        `Steps of this session: ${progress.done}/${progress.total} done.\n${this.todos.text('session', target.sessionId)}${tail ? `\n${tail}` : ''}`,
        false,
      )
    }
    const row = target
    if (row.status !== 'approved' && row.status !== 'executing') {
      const why =
        row.status === 'awaiting_approval' || row.status === 'draft'
          ? 'Do not start it before the user approves it.'
          : row.status === 'cancelled'
            ? 'The user cancelled it: stop working on it.'
            : 'Its steps can no longer change.'
      return toolError(`The plan "${row.title}" is ${STATUS_TEXT[row.status]}. ${why}`)
    }
    return this.savePlanSteps(row, parseTodos(a.todos, this.todos.rows('plan', row.id)))
  }

  /** `plan_step`: one step of an approved plan, by any bot doing it (delegated work reports as it goes). */
  private markStep(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const row = this.plans.resolveRow(ctx.bot, trimmedString(a.plan))
    if (row.status !== 'approved' && row.status !== 'executing')
      return toolText(
        `The plan "${row.title}" is ${STATUS_TEXT[row.status]}: its steps can no longer change.`,
        true,
      )
    const status = TodoStatus.safeParse(a.status)
    if (!status.success) throw new ToolInputError('"status" must be pending, in_progress, done or skipped')
    const ref = trimmedString(a.step)
    const existing = this.todos.rows('plan', row.id)
    const match = resolveByRef(existing, ref, {
      id: (t) => t.id,
      names: (t) => [t.title],
      ambiguous: { exact: 'first', partial: 'first' },
    })
    const step = 'found' in match ? match.found : null
    if (!step)
      return toolText(
        `The plan "${row.title}" has no step "${ref}". Its steps:\n${this.todos.text('plan', row.id)}`,
        true,
      )
    const note = textArg(a, 'note', 1000)
    return this.savePlanSteps(
      row,
      existing.map((t) => ({
        id: t.id,
        title: t.title,
        detail: t.detail,
        status: t.id === step.id ? status.data : t.status,
        note: t.id === step.id && note ? note : t.note,
      })),
    )
  }

  private savePlanSteps(row: PlanRow, todos: ReturnType<typeof parseTodos>): ToolResult {
    this.todos.replace('plan', row.id, todos)
    const progress = planProgress(todos)
    const finished = progress.done === progress.total
    const started = todos.some((t) => t.status !== 'pending')
    const next = finished
      ? this.plans.markDone(row.id)
      : row.status === 'approved' && started
        ? this.plans.update(row.id, { status: 'executing' })
        : this.plans.update(row.id, {})
    this.plans.syncCard(next)
    this.plans.emit(next)
    if (next.session_id) this.plans.sessions?.stepsChanged(next.session_id)
    const tail = progressTail(todos, 'Every step is done or skipped: the plan is finished.')
    return toolText(
      `Steps of "${next.title}": ${progress.done}/${progress.total} done.\n${this.todos.text('plan', row.id)}${tail ? `\n${tail}` : ''}`,
      false,
      { detail: next.title },
    )
  }

  private projectName(projectId: string | null): string {
    if (!projectId) return 'general'
    return this.deps.projects.find(projectId)?.name ?? 'general'
  }

  private read(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const row = this.plans.resolveRow(ctx.bot, trimmedString(a.plan))
    const author = this.deps.store.bots.find(row.bot_id)?.name ?? 'a removed bot'
    const steps = this.todos
      .rows('plan', row.id)
      .map((t) => `${CHECKBOX[t.status]} ${t.title} (${t.id})${t.note ? ` — ${t.note}` : ''}`)
      .join('\n')
    const lines = [
      `# ${row.title}`,
      `${row.id} · ${STATUS_TEXT[row.status]} · revision ${row.revision} · by ${author} · project: ${this.projectName(row.project_id)} · runs in: ${row.execution}`,
      ...(row.folder ? [`Folder: ${row.folder}`] : []),
      ...(row.feedback ? [`User feedback: "${row.feedback}"`] : []),
      '',
      `Summary: ${row.summary}`,
      '',
      row.body,
      '',
      '## Steps',
      steps || '(none)',
    ]
    return toolText(lines.join('\n'), false, { detail: row.title })
  }

  private async searchTool(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const current = this.deps.projects.current(ctx.conversationId)?.id ?? null
    const view = projectViewArg(a.project, current, this.deps.projects)
    if ('problem' in view) return toolError(view.problem)
    const status = PlanStatus.safeParse(a.status)
    const query = trimmedString(a.query)
    const plans = query
      ? await this.plans.search(query, view, status.success ? status.data : null)
      : this.plans
          .list(status.success ? { status: status.data } : {})
          .filter((p) => inProjectView(p.projectId, view))
          .slice(0, 15)
    if (!plans.length)
      return toolText(query ? `No plan matches "${query}".` : 'There are no plans yet.', false, {
        detail: query,
      })
    const lines = plans.map((p) => {
      const progress = planProgress(p.steps)
      const date = new Date(p.updatedAt).toISOString().slice(0, 10)
      return (
        `- ${p.title} [${p.status}, ${progress.done}/${progress.total} steps] (${p.id}) · ` +
        `${this.projectName(p.projectId)} · ${date} — ${oneLine(p.summary, 220)}`
      )
    })
    return toolText(`${lines.join('\n')}\n\nRead one with plan_get.`, false, { detail: query })
  }
}
