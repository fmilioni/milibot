import type { NewAgentMessage } from '@milibot/agent'
import {
  type LogFn,
  type Message,
  type MessagePayload,
  type Plan,
  planProgress,
  type PlanStep,
  type SessionBriefPayload,
  type WorkSessionPayload,
  type WorkSessionStatus,
} from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { BoardCardLinks } from '../boards'
import { SESSIONS_DIR, WORKSPACE_DIR } from '../files'
import type { ProjectService } from '../projects'
import { oneLine } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { storedChanges } from './changes'
import { isFinished, type SessionRow } from './store'

export const STATUS_TEXT: Record<WorkSessionStatus, string> = {
  preparing: 'starting',
  running: 'running',
  idle: 'waiting (no turn running)',
  done: 'done',
  failed: 'failed',
  cancelled: 'stopped by the user',
}

export interface SessionCardsDeps {
  store: WorkspaceStore
  projects: Pick<ProjectService, 'find'>
  cards?: BoardCardLinks
  /** Pull request rules of the session (its plan's merge choice, else the workspace's). */
  pullRequestNote?: (plan: Plan | null) => string
  plan: (id: string) => Plan | null
  steps: (row: SessionRow) => PlanStep[]
  branch: (row: SessionRow) => string | null
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  log?: LogFn
}

/**
 * The messages a session posts: the `work_session` card where it started (what the bot reads there and the user
 * follows it by) and the brief at the top of its own conversation.
 */
export class SessionCards {
  constructor(private readonly deps: SessionCardsDeps) {}

  payload(row: SessionRow, removed = false): WorkSessionPayload {
    return {
      type: 'work_session',
      sessionId: row.id,
      botId: row.bot_id,
      title: row.title,
      goal: oneLine(row.goal, 400),
      status: row.status,
      steps: planProgress(this.deps.steps(row)),
      planId: row.plan_id,
      planConversationId: row.plan_id ? (this.deps.plan(row.plan_id)?.conversationId ?? null) : null,
      resultSummary: row.result_summary,
      changes: storedChanges(row)?.totals ?? null,
      ...(removed ? { removed: true } : {}),
    }
  }

  /** What the bot reads about its session in the chat where it started it. */
  content(row: SessionRow): string {
    if (isFinished(row.status))
      return (
        `[Milibot] Your work session "${row.title}" (${row.id}) ended: ${STATUS_TEXT[row.status]}.` +
        (row.result_summary ? `\nResult: ${row.result_summary}` : '')
      )
    return (
      `[Milibot] You started the work session "${row.title}" (${row.id}); it runs in parallel in its own ` +
      'conversation and its result comes back here when it ends. Do not do its work here.'
    )
  }

  /** Posts the card in the conversation the session started from; returns its message id. */
  postOrigin(row: SessionRow, turnId: string | null): string {
    return this.deps.appendMessage({
      conversationId: row.origin_conversation_id,
      authorType: 'bot',
      authorBotId: row.bot_id,
      kind: 'card',
      content: this.content(row),
      payload: this.payload(row),
      turnId,
    }).id
  }

  sync(row: SessionRow): void {
    if (!row.origin_message_id) return
    try {
      const payload = this.deps.store.messages.payload(row.origin_message_id) as WorkSessionPayload | null
      if (payload?.type !== 'work_session') return
      this.deps.updateMessage(row.origin_message_id, {
        content: this.content(row),
        payload: this.payload(row, payload.removed === true),
      })
    } catch (err) {
      this.deps.log?.('warn', 'work session card update failed', {
        sessionId: row.id,
        err: errorMessage(err),
      })
    }
  }

  markRemoved(row: SessionRow): void {
    if (!row.origin_message_id) return
    try {
      this.deps.updateMessage(row.origin_message_id, { payload: this.payload(row, true) })
    } catch (err) {
      this.deps.log?.('warn', 'work session card update failed', {
        sessionId: row.id,
        err: errorMessage(err),
      })
    }
  }

  brief(row: SessionRow): string {
    const project = row.project_id ? this.deps.projects.find(row.project_id) : null
    const plan = row.plan_id ? this.deps.plan(row.plan_id) : null
    const branch = this.deps.branch(row)
    const pullRequests = this.deps.pullRequestNote?.(plan)
    const chosenFolder =
      !row.repo_name && row.cwd && row.cwd !== WORKSPACE_DIR && !row.cwd.startsWith(`${SESSIONS_DIR}/`)
    const lines = [
      `# Session brief: ${row.title}`,
      `Goal:\n${row.goal}`,
      `Working directory: ${row.cwd ?? WORKSPACE_DIR}` +
        (chosenFolder ? ' (the project folder chosen for this work; it may already have files)' : ''),
      ...(row.repo_name
        ? [
            `Repository: ${row.repo_name}${branch ? ` — your own worktree on branch ${branch}` : ''} (commit there; the chat's worktree is not this one).`,
          ]
        : []),
      ...(project ? [`Project: ${project.name}`] : []),
      ...(plan
        ? [
            `Approved plan: "${plan.title}" (${plan.id}); its steps are the session's steps (todo_write).`,
            `Summary: ${plan.summary}`,
            plan.body,
          ]
        : []),
      ...(pullRequests ? [`Pull requests:\n${pullRequests}`] : []),
    ]
    const cardId = this.deps.cards?.cardOfSession(row.id)
    const card = cardId ? this.deps.cards?.briefFor(cardId) : null
    if (card) lines.push(card)
    return lines.join('\n\n')
  }

  postBrief(row: SessionRow): void {
    const payload: SessionBriefPayload = {
      type: 'session_brief',
      sessionId: row.id,
      botId: row.bot_id,
      title: row.title,
      goal: row.goal,
      planId: row.plan_id,
      projectId: row.project_id,
      repoName: row.repo_name,
      cwd: row.cwd,
      cardId: this.deps.cards?.cardOfSession(row.id) ?? null,
    }
    this.deps.appendMessage({
      conversationId: row.conversation_id,
      authorType: 'system',
      kind: 'card',
      content: this.brief(row),
      payload,
    })
  }

  /** The brief in the session follows where the session works. */
  updateBrief(row: SessionRow): void {
    const brief = this.deps.store.messages.firstCard(row.conversation_id, 'session_brief')
    const payload = brief?.payload as SessionBriefPayload | null | undefined
    if (!brief || !payload) return
    try {
      this.deps.updateMessage(brief.id, {
        content: this.brief(row),
        payload: { ...payload, cwd: row.cwd, repoName: row.repo_name },
      })
    } catch (err) {
      this.deps.log?.('warn', 'work session brief update failed', {
        sessionId: row.id,
        err: errorMessage(err),
      })
    }
  }
}
