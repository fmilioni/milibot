import { laneInfo, type ToolExecContext, type ToolResult } from '@milibot/agent'
import {
  textArg,
  type ToolArgs,
  toolError,
  ToolInputError,
  toolText,
  trimmedString,
} from '@milibot/agent/tools'
import type { Bot, WorkSessionStatus } from '@milibot/shared'

import type { BoardCardLinks } from '../boards'
import { sessionFolder } from '../files'
import type { ProjectService } from '../projects'
import { modelRequestArgs, modelRequestNote, type ModelRequests } from '../providers'
import { sanitizeRepoName } from '../repos'
import { type ToolHandlers, ToolSwitch } from '../tools-core'
import { STATUS_TEXT } from './cards'
import type { SessionPlans, WorkSessionService } from './service'
import { isFinished } from './store'

export interface SessionToolsDeps {
  sessions: WorkSessionService
  plans: Pick<SessionPlans, 'resolve'>
  projects: ProjectService
  /** The bot's current chat, else its DM (`GroupService.cardConversation`). */
  cardConversation: (bot: Bot, conversationId: string | null) => string
  /** Models a session can be asked to run on. */
  models?: ModelRequests
  /** Board cards a session can work on. */
  cards?: BoardCardLinks
}

/** The bots' `session_start`, `session_finish` and `list_models`. */
export class SessionTools extends ToolSwitch {
  readonly name = 'work sessions'
  protected readonly handlers: ToolHandlers = {
    session_start: (ctx, a) => this.start(ctx, a),
    session_finish: (ctx, a) => this.finish(ctx, a),
    list_models: (ctx, a) =>
      toolText(this.deps.models?.list(ctx.bot, textArg(a, 'query') || null) ?? 'No model list here.', false, {
        detail: textArg(a, 'query'),
      }),
  }

  constructor(private readonly deps: SessionToolsDeps) {
    super()
  }

  private start(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const kind = ctx.laneKey ? laneInfo(ctx.laneKey).kind : 'main'
    if (kind !== 'main' && kind !== 'internal')
      return toolError('You are already in a work session: do the work here.')
    const title = textArg(a, 'title', 120)
    const goal = textArg(a, 'goal', 8000)
    if (!title) throw new ToolInputError('"title" is required')
    if (!goal) throw new ToolInputError('"goal" is required (everything the work needs)')
    const plan = trimmedString(a.plan) ? this.deps.plans.resolve(ctx.bot, trimmedString(a.plan)) : null
    if (plan && plan.status !== 'approved' && plan.status !== 'executing')
      return toolError(`The plan "${plan.title}" is not approved: submit it with plan_submit first.`)
    if (plan?.sessionId && this.deps.sessions.find(plan.sessionId))
      return toolError(`The plan "${plan.title}" already runs in the work session ${plan.sessionId}.`)
    let projectId: string | null
    if (trimmedString(a.project)) {
      const found = this.deps.projects.resolve(trimmedString(a.project))
      if ('problem' in found) throw new ToolInputError(found.problem)
      projectId = 'project' in found ? found.project.id : null
    } else projectId = plan?.projectId ?? this.deps.projects.current(ctx.conversationId)?.id ?? null
    let repo: string | null = trimmedString(a.repo) || null
    if (repo) sanitizeRepoName(repo)
    const folder = repo
      ? null
      : trimmedString(a.folder)
        ? sessionFolder(trimmedString(a.folder))
        : (plan?.folder ?? null)
    const asked = modelRequestArgs(a)
    const model = asked ? this.deps.models?.request(ctx.bot, asked, null) : null
    if (asked && !model) return toolError('Choosing a model for a session is not available here.')
    if (model && !model.ok) return toolError(model.error)
    let cardId: string | null = null
    if (trimmedString(a.card)) {
      if (!this.deps.cards) throw new ToolInputError('boards are not available here')
      cardId = this.deps.cards.resolveCardId(trimmedString(a.card))
    }
    const session = this.deps.sessions.open({
      bot: ctx.bot,
      originConversationId: this.deps.cardConversation(ctx.bot, ctx.conversationId),
      title,
      goal,
      plan,
      projectId,
      repo,
      folder,
      turnId: ctx.turnId,
      model: model?.ok ? model.choice : (plan?.model ?? null),
      cardId,
    })
    repo = session.repoName
    return toolText(
      `Work session "${session.title}" started (${session.id}): it runs in parallel in its own conversation` +
        `${repo ? `, on its own worktree of ${repo}` : folder ? `, in ${session.cwd}` : ''}, and the user follows it from its card here. ` +
        `${model?.ok ? `${modelRequestNote(model)} ` : ''}Its ` +
        'result comes back to this conversation when it ends. Do not do its work here: tell the user it started.',
      false,
      { detail: session.title },
    )
  }

  private finish(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const sessionId = ctx.laneKey ? laneInfo(ctx.laneKey).sessionId : null
    const row = sessionId ? this.deps.sessions.find(sessionId) : null
    if (!row) return toolError('session_finish only works inside a work session.')
    if (isFinished(row.status))
      return toolText(
        `This session already ended (${STATUS_TEXT[row.status]})` +
          (row.result_summary ? ` with this result: "${row.result_summary.slice(0, 300)}"` : '') +
          '. Nothing to do: end your turn with one short line.',
        false,
        { detail: row.title },
      )
    const summary = textArg(a, 'summary', 4000)
    if (!summary) throw new ToolInputError('"summary" is required')
    const status: WorkSessionStatus = a.status === 'failed' ? 'failed' : 'done'
    const finished = this.deps.sessions.finishFromLane(row, status, summary)
    return toolText(
      'Session closed; its summary goes to the chat where it started. End your turn with one short line.',
      false,
      { detail: finished.title },
    )
  }
}
