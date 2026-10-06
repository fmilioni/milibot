import {
  type AgentHost,
  laneInfo,
  type NewAgentMessage,
  sessionLaneKey,
  type WorkSessionDirectory,
  type WorkSessionView,
} from '@milibot/agent'
import { cliKeys } from '@milibot/agent/cli'
import {
  type Bot,
  CLI_ENGINES,
  type ListWorkSessionsQuery,
  type LogFn,
  type Message,
  type MessagePayload,
  type ModelChoice,
  newId,
  type Plan,
  planProgress,
  type PlanStep,
  type SessionChanges,
  type ToolCallRow,
  type WorkSession,
  type WorkSessionDetail,
  type workSessionEndpoints,
  type WorkSessionStatus,
  type WorkspaceEvent,
} from '@milibot/shared'

import { parseModelSpec } from '../../db/model-spec'
import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { BoardCardLinks } from '../boards'
import {
  assertFolderFree,
  checkPreparedFolder,
  FOLDER_SCRIPT,
  sessionFolder,
  SESSIONS_DIR,
  WORKSPACE_DIR,
} from '../files'
import type { PlanService } from '../plans'
import type { ProjectService } from '../projects'
import { isRepoUrl, runCheckout, sanitizeRepoName, slugPart, type WorktreeStore } from '../repos'
import type { TodoStore } from '../todos'
import type { GuestClient, VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { SessionCards, STATUS_TEXT } from './cards'
import { SessionChangesTracker, storedChanges } from './changes'
import { SessionLanes } from './lanes'
import { isFinished, type SessionRow, SessionStore } from './store'
import { SessionTranscript } from './transcript'

const DEFAULT_MAX_ACTIVE_PER_BOT = 2
const MAX_ACTIVE_SETTING = 'sessions.max_active_per_bot'
const inputSeqKey = (laneKey: string) => `sessions.input_seq.${laneKey}`
const EMIT_DELAY_MS = 250

export type SessionPlans = Pick<PlanService, 'get' | 'resolve' | 'setStatus' | 'attachSession'>

export interface WorkSessionServiceDeps {
  db: Db
  store: WorkspaceStore
  todos: TodoStore
  worktrees: WorktreeStore
  host: Pick<AgentHost, 'enqueueTurn' | 'control' | 'closeLane'>
  vm: VmController
  projects: Pick<ProjectService, 'find'>
  plans: SessionPlans
  /** Tool calls of a conversation, oldest first (the last `limit`). */
  toolCalls: (conversationId: string, limit: number) => ToolCallRow[]
  conversationCost: (conversationId: string) => number
  /** Forgets the MCP token of a lane that ended. */
  revokeLane: (laneKey: string) => void
  botEnv?: (bot: Bot) => Promise<Record<string, string>>
  /** Pull request rules of the session (its plan's merge choice, else the workspace's). */
  pullRequestNote?: (plan: Plan | null) => string
  /** Board cards a session can work on. */
  cards?: BoardCardLinks
  /** A session ended or saved its patches: its worktree may be removed. */
  worktreeFinished?: () => void
  /** A session on a model other than its bot's opened or ended (who reads the bot's secret files). */
  modelLanesChanged?: () => void
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  emit: (event: WorkspaceEvent) => void
  now: () => number
  log?: LogFn
}

/**
 * Work sessions: long work of a bot in a conversation of its own, run in a lane of the bot next to its chats.
 * Owns their lifecycle and the folder each works in; the cards are `cards.ts`'s, what the lanes report and read
 * `lanes.ts`'s, and for API-provider bots the lane's transcript `transcript.ts`'s.
 */
export class WorkSessionService {
  private readonly emitTimers = new Map<string, NodeJS.Timeout>()
  /** Sessions closed by the bot during a turn: their lane closes once that turn ends. */
  private readonly closing = new Set<string>()
  /** Sessions whose folder exists (checked or made since the runtime started), and those being prepared. */
  private readonly ready = new Set<string>()
  private readonly preparing = new Map<string, Promise<void>>()
  /** Repository given when each session started (a URL or a name), for a folder made later. */
  private readonly repoRefs = new Map<string, string>()
  private readonly store: SessionStore
  private readonly transcript: SessionTranscript
  private readonly changeTracker: SessionChangesTracker
  private readonly cards: SessionCards
  private readonly lanes: SessionLanes

  constructor(private readonly deps: WorkSessionServiceDeps) {
    this.store = new SessionStore(deps.db, deps.now)
    this.transcript = new SessionTranscript(deps.db, deps.now)
    this.changeTracker = new SessionChangesTracker({
      store: this.store,
      vm: deps.vm,
      bot: (id) => this.bot(id),
      emit: deps.emit,
      onSaved: (row) => {
        this.cards.sync(row)
        this.emitNow(row.id)
        if (isFinished(row.status)) this.deps.worktreeFinished?.()
      },
      now: deps.now,
      ...(deps.log ? { log: deps.log } : {}),
    })
    this.cards = new SessionCards({
      store: deps.store,
      projects: deps.projects,
      cards: deps.cards,
      pullRequestNote: deps.pullRequestNote,
      plan: (id) => this.planOf(id),
      row: (id) => this.store.row(id),
      steps: (row) => this.steps(row),
      branch: (row) => this.branch(row),
      appendMessage: deps.appendMessage,
      updateMessage: deps.updateMessage,
      log: deps.log,
    })
    this.lanes = new SessionLanes({
      sessions: this.store,
      store: deps.store,
      toolCalls: deps.toolCalls,
      steps: (row) => this.steps(row),
      revokeLane: deps.revokeLane,
      changed: (id, soon) => (soon ? this.emitSoon(id) : this.emitNow(id)),
    })
  }

  /** Work sessions a board card can link to, newest first. */
  linkTargets(): Array<{ id: string; title: string }> {
    return this.store.linkTargets()
  }

  /** Folders of open sessions whose plan may merge its pull request (the `gh` wrapper's policy). */
  mergePrFolders(): string[] {
    return this.store
      .openPlanFolders()
      .filter((f) => this.planOf(f.planId)?.mergePr === true)
      .map((f) => f.cwd)
  }

  /** A session by id (null: none, or deleted). */
  find(id: string): SessionRow | null {
    return this.store.row(id)
  }

  start(): void {
    this.changeTracker.start()
    this.store.resetRunning()
  }

  stop(): void {
    for (const timer of this.emitTimers.values()) clearTimeout(timer)
    this.emitTimers.clear()
    this.changeTracker.stop()
  }

  /** The session's steps: its plan's, else its own list. */
  private steps(row: SessionRow): PlanStep[] {
    if (row.plan_id) {
      const planSteps = this.deps.todos.steps('plan', row.plan_id)
      if (planSteps.length) return planSteps
    }
    return this.deps.todos.steps('session', row.id)
  }

  private plannedBranch(row: SessionRow, bot: Bot | null): string | null {
    if (!row.repo_name) return null
    return `bot/${bot?.slug ?? 'bot'}/${slugPart(row.title, 'work')}-${row.id.slice(-8).toLowerCase()}`
  }

  private branch(row: SessionRow): string | null {
    if (row.worktree_id) return this.deps.worktrees.get(row.worktree_id)?.branch ?? null
    return this.plannedBranch(row, this.bot(row.bot_id))
  }

  private bot(id: string): Bot | null {
    return this.deps.store.bots.find(id)
  }

  private toSession(row: SessionRow): WorkSession {
    return {
      id: row.id,
      botId: row.bot_id,
      conversationId: row.conversation_id,
      originConversationId: row.origin_conversation_id,
      originMessageId: row.origin_message_id,
      planId: row.plan_id,
      projectId: row.project_id,
      title: row.title,
      goal: row.goal,
      status: row.status,
      cwd: row.cwd,
      repoName: row.repo_name,
      branch: this.branch(row),
      model: parseModelSpec(row.model_spec),
      lane: this.lanes.lane(row.id),
      steps: planProgress(this.steps(row)),
      costUsd: this.deps.conversationCost(row.conversation_id),
      resultSummary: row.result_summary,
      replacedBy: this.cards.replacedBy(row),
      changes: storedChanges(row)?.totals ?? null,
      subagents: this.lanes.subagents(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
    }
  }

  get(id: string): WorkSession {
    return this.toSession(this.store.requireRow(id))
  }

  detail(id: string): WorkSessionDetail {
    const row = this.store.requireRow(id)
    return { ...this.toSession(row), todos: this.steps(row) }
  }

  list(query: ListWorkSessionsQuery = {}): WorkSession[] {
    return this.store.list(query).map((r) => this.toSession(r))
  }

  /** The session a conversation belongs to (its turns run in the session's lane). */
  forConversation(conversationId: string): {
    sessionId: string
    ended?: { originConversationId: string; title: string }
  } | null {
    const row = this.store.byConversation(conversationId)
    if (!row) return null
    return isFinished(row.status)
      ? { sessionId: row.id, ended: { originConversationId: row.origin_conversation_id, title: row.title } }
      : { sessionId: row.id }
  }

  /** The session of a lane, with the plan it executes (null: the chat lane). */
  sessionOfLane(laneKey: string | undefined): { id: string; planId: string | null } | null {
    if (!laneKey) return null
    const { sessionId } = laneInfo(laneKey)
    const row = sessionId ? this.store.row(sessionId) : null
    return row ? { id: row.id, planId: row.plan_id } : null
  }

  /** Models of the bot's open sessions opened on a chosen model. */
  openModels(botId: string): ModelChoice[] {
    return this.store
      .open(botId)
      .map((row) => parseModelSpec(row.model_spec))
      .filter((m): m is ModelChoice => m !== null)
  }

  /** Model a lane of a session was opened with (null: the bot's own). */
  modelOfLane(laneKey: string | undefined): ModelChoice | null {
    if (!laneKey) return null
    const { sessionId } = laneInfo(laneKey)
    const row = sessionId ? this.store.row(sessionId) : null
    return row ? parseModelSpec(row.model_spec) : null
  }

  /** Folder `bash` runs in by default for a lane of a session. */
  cwdFor(laneKey: string | undefined): string | null {
    if (!laneKey) return null
    const { sessionId } = laneInfo(laneKey)
    return sessionId ? (this.store.row(sessionId)?.cwd ?? null) : null
  }

  private emitNow(id: string): void {
    const timer = this.emitTimers.get(id)
    if (timer) clearTimeout(timer)
    this.emitTimers.delete(id)
    const row = this.store.row(id)
    if (row) this.deps.emit({ type: 'work_session.updated', payload: { session: this.toSession(row) } })
  }

  private emitSoon(id: string): void {
    if (this.emitTimers.has(id)) return
    this.emitTimers.set(
      id,
      setTimeout(() => this.emitNow(id), EMIT_DELAY_MS),
    )
  }

  private planOf(id: string): Plan | null {
    try {
      return this.deps.plans.get(id)
    } catch {
      return null
    }
  }

  private maxActive(): number {
    const value = this.deps.store.settings.get<number>(MAX_ACTIVE_SETTING, DEFAULT_MAX_ACTIVE_PER_BOT)
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ACTIVE_PER_BOT
  }

  /**
   * Opens a session: its conversation, row and cards, and its first turn, which waits for the folder to be
   * ready. Returns at once: the session runs in parallel.
   */
  open(input: {
    bot: Bot
    originConversationId: string
    title: string
    goal: string
    plan: Plan | null
    projectId: string | null
    repo: string | null
    /** Folder under /workspace to work in when there is no repository; null = a folder of its own. */
    folder?: string | null
    turnId: string | null
    /** Model asked for this work; null = the bot's own. */
    model?: ModelChoice | null
    /** Board card it works on (default: the card of its plan). */
    cardId?: string | null
  }): WorkSession & { replaced: Array<{ id: string; title: string }> } {
    const { bot } = input
    const cardId = input.cardId ?? (input.plan ? (this.deps.cards?.cardOfPlan(input.plan.id) ?? null) : null)
    const stale = this.staleFor(bot.id, input.plan?.id ?? null, cardId)
    const active = this.store.countOpen(bot.id) - stale.length
    const max = this.maxActive()
    if (active >= max)
      throw new DaemonError(
        'conflict',
        `You already have ${active} work sessions open (the limit is ${max}): finish one before opening another.`,
      )
    const id = newId('workSession')
    const short = id.slice(-8).toLowerCase()
    const repoName = input.repo ? sanitizeRepoName(input.repo) : null
    const folder = !repoName && input.folder ? sessionFolder(input.folder) : null
    if (folder)
      assertFolderFree(
        folder,
        this.store.openFolders().filter((f) => !stale.some((row) => row.cwd === f.cwd)),
      )
    const cwd = repoName
      ? `${WORKSPACE_DIR}/worktrees/${repoName}/${bot.slug}-${short}`
      : (folder ?? `${SESSIONS_DIR}/${bot.slug}-${short}`)
    const conversation = this.deps.store.conversations.create({
      type: 'session',
      botIds: [bot.id],
      title: input.title,
      projectId: input.projectId,
    })
    let row = this.store.insert({
      id,
      botId: bot.id,
      conversationId: conversation.id,
      originConversationId: input.originConversationId,
      planId: input.plan?.id ?? null,
      projectId: input.projectId,
      title: input.title,
      goal: input.goal,
      cwd,
      repoName,
      model: input.model ?? null,
    })
    if (input.model) this.deps.modelLanesChanged?.()
    this.deps.emit({ type: 'conversation.created', payload: { conversation } })
    for (const old of stale) this.replace(old, id)
    if (cardId) this.linkCard(cardId, row)
    this.cards.postBrief(row)
    row = this.store.update(id, { origin_message_id: this.cards.postOrigin(row, input.turnId) })
    if (input.plan) this.deps.plans.attachSession(input.plan.id, id)
    if (input.repo) this.repoRefs.set(id, input.repo)
    this.deps.host.enqueueTurn({
      botId: bot.id,
      conversationId: conversation.id,
      trigger: 'session_start',
      laneKey: sessionLaneKey(bot.id, id),
      waitFor: this.ensureReady(id),
      note: '[Milibot] The work session starts now: work towards its goal (see the session brief).',
    })
    this.emitNow(id)
    return { ...this.toSession(row), replaced: stale.map((old) => ({ id: old.id, title: old.title })) }
  }

  /**
   * The bot's sessions on the same plan or card left waiting with no turn running: a new session for that
   * work replaces them (e.g. a review reopened after the fixes came back). One with a turn running stays.
   */
  private staleFor(botId: string, planId: string | null, cardId: string | null): SessionRow[] {
    if (!planId && !cardId) return []
    return this.store
      .open(botId)
      .filter((row) => row.status === 'idle' && this.lanes.lane(row.id).status === 'idle')
      .filter(
        (row) =>
          (planId !== null && row.plan_id === planId) ||
          (cardId !== null && this.deps.cards?.cardOfSession(row.id) === cardId),
      )
  }

  private replace(row: SessionRow, by: string): void {
    const next = this.finish(this.store.update(row.id, { replaced_by: by }), 'cancelled', row.result_summary)
    void this.closeLane(next).catch((err: unknown) =>
      this.deps.log?.('warn', 'work session lane close failed', {
        sessionId: row.id,
        err: errorMessage(err),
      }),
    )
  }

  private linkCard(cardId: string, row: SessionRow): void {
    try {
      this.deps.cards?.linkSession(cardId, { id: row.id, title: row.title }, row.bot_id)
    } catch (err) {
      this.deps.log?.('warn', 'work session card link failed', { sessionId: row.id, err: errorMessage(err) })
    }
  }

  /**
   * Makes sure the session's folder exists before a turn of its lanes: made when the session starts, or on
   * its first turn with the VM running when it was off then (the folder planned at the start is kept).
   */
  ensureReady(id: string): Promise<void> {
    if (this.ready.has(id)) return Promise.resolve()
    const running = this.preparing.get(id)
    if (running) return running
    const task = this.prepare(id).finally(() => this.preparing.delete(id))
    this.preparing.set(id, task)
    return task
  }

  /**
   * The session's folder: its own worktree of the repository (the checkout script of `repo_checkout`, at a
   * path of its own), the folder it was given (made when missing) or an empty folder. When that fails the
   * session works in /workspace; without the VM nothing changes and the next turn tries again.
   */
  private async prepare(id: string): Promise<void> {
    const row = this.store.row(id)
    const bot = row ? this.bot(row.bot_id) : null
    if (!row || !bot || !row.cwd) return
    let guest: GuestClient
    try {
      guest = await this.deps.vm.guest()
    } catch (err) {
      this.deps.log?.('info', 'work session folder waits for the VM', {
        sessionId: id,
        err: errorMessage(err),
      })
      return
    }
    const repo = this.repoRefs.get(id) ?? row.repo_name
    try {
      if (row.repo_name && repo) {
        // A session reopened after its worktree was cleaned up comes back on the branch it ended on.
        const worktree = row.worktree_id ? this.deps.worktrees.get(row.worktree_id) : null
        const branch = worktree?.branch ?? (this.plannedBranch(row, bot) as string)
        const { code, stdout, stderr, info } = await runCheckout(guest, {
          bot,
          repo,
          name: row.repo_name,
          branch,
          baseBranch: '',
          worktreePath: row.cwd,
          botEnv: (await this.deps.botEnv?.(bot)) ?? {},
        })
        if (code !== 0) throw new Error((stderr || stdout).trim().slice(0, 500))
        if (worktree?.status === 'released') this.deps.worktrees.reactivate(worktree.id)
        if (!worktree) {
          const created = this.deps.worktrees.insert({
            botId: bot.id,
            repoName: row.repo_name,
            repoUrl: isRepoUrl(repo) ? repo : null,
            worktreePath: row.cwd,
            branch: info.BRANCH || branch,
            baseBranch: info.BASE || null,
            sessionId: row.id,
          })
          this.store.update(id, { worktree_id: created.id })
        }
      } else {
        const result = await guest.exec({
          user: `bot-${bot.slug}`,
          cmd: FOLDER_SCRIPT,
          env: { SESSION_DIR: row.cwd, WORKSPACE_ROOT: WORKSPACE_DIR },
          timeoutMs: 30_000,
        })
        if (result.code !== 0) throw new Error(result.stderr.trim().slice(0, 500))
        checkPreparedFolder(row.cwd, result.stdout)
      }
    } catch (err) {
      this.deps.log?.('warn', 'work session folder not prepared: it works in /workspace', {
        sessionId: id,
        err: errorMessage(err),
      })
      this.cards.updateBrief(this.store.update(id, { cwd: '/workspace', repo_name: null }))
    }
    this.ready.add(id)
    try {
      await this.changeTracker.takeBaseline(this.store.requireRow(id), bot, guest)
    } catch (err) {
      this.deps.log?.('warn', 'work session baseline not taken', {
        sessionId: id,
        err: errorMessage(err),
      })
    } finally {
      this.emitNow(id)
    }
  }

  private finish(row: SessionRow, status: WorkSessionStatus, summary: string | null): SessionRow {
    const next = this.store.update(row.id, {
      status,
      result_summary: summary,
      finished_at: this.deps.now(),
    })
    this.closing.delete(row.id)
    this.cards.sync(next)
    const steps = this.steps(next)
    if (status === 'done' && next.plan_id && steps.length && steps.every((s) => s.status !== 'pending')) {
      const plan = this.planOf(next.plan_id)
      if (plan && (plan.status === 'approved' || plan.status === 'executing'))
        this.deps.plans.setStatus(plan.id, 'done')
    }
    this.emitNow(row.id)
    this.changeTracker.markChanged(row.id, 0)
    if (next.model_spec) this.deps.modelLanesChanged?.()
    if (next.worktree_id) this.deps.worktreeFinished?.()
    return next
  }

  /** Settings of a lane's CLI sessions (Claude Code, Codex) and of its helpers' lanes (`<lane>:sub:<n>`). */
  private deleteCliSettings(laneKey: string): void {
    const settings = this.deps.store.settings
    settings.delete(CLI_ENGINES.flatMap((engine) => cliKeys(engine).lane(laneKey)))
    settings.deleteLike(
      CLI_ENGINES.map((engine) => cliKeys(engine).session('%')),
      `%.${laneKey}:sub:%`,
    )
  }

  /** Ends the lane of a session that finished: its CLI process, MCP token and CLI session. */
  private async closeLane(row: SessionRow): Promise<void> {
    const laneKey = sessionLaneKey(row.bot_id, row.id)
    this.closing.delete(row.id)
    this.deps.revokeLane(laneKey)
    this.deleteCliSettings(laneKey)
    await this.deps.host.closeLane(laneKey)
  }

  stopSession(id: string): WorkSession {
    const row = this.store.requireRow(id)
    if (isFinished(row.status)) return this.toSession(row)
    this.deps.host.control(row.bot_id, 'stop', { sessionId: row.id })
    const next = this.finish(row, 'cancelled', row.result_summary)
    void this.closeLane(next).catch((err: unknown) =>
      this.deps.log?.('warn', 'work session lane close failed', {
        sessionId: id,
        err: errorMessage(err),
      }),
    )
    return this.toSession(next)
  }

  deleteSession(id: string): void {
    const row = this.store.requireRow(id)
    if (!isFinished(row.status))
      throw new DaemonError('conflict', 'Stop the work session before deleting it', { status: row.status })
    this.deps.store.db.transaction(() => {
      this.store.delete(row)
      this.deps.store.conversations.softDelete(row.conversation_id)
    })()
    this.lanes.forget(id)
    this.ready.delete(id)
    this.repoRefs.delete(id)
    this.changeTracker.forget(id)
    if (row.shadow_git) void this.changeTracker.removeShadow(row)
    this.cards.markRemoved(row)
    this.deps.emit({ type: 'work_session.deleted', payload: { sessionId: id } })
    this.deps.emit({ type: 'conversation.deleted', payload: { conversationId: row.conversation_id } })
  }

  /** The user wrote in a session's conversation: a finished session opens again. */
  onUserMessage(conversationId: string): void {
    const row = this.store.byConversation(conversationId)
    if (!row || !isFinished(row.status)) return
    const next = this.store.update(row.id, { status: 'idle', finished_at: null })
    if (row.worktree_id && this.deps.worktrees.get(row.worktree_id)?.status === 'released')
      this.ready.delete(row.id)
    this.cards.sync(next)
    this.emitNow(row.id)
  }

  /** A turn ended: a session waits for the next one, or its lane closes when the bot finished it. */
  turnFinished(info: { conversationId: string }): void {
    const row = this.store.byConversation(info.conversationId)
    if (!row) return
    if (this.closing.has(row.id)) {
      void this.closeLane(row).catch((err: unknown) =>
        this.deps.log?.('warn', 'work session lane close failed', {
          sessionId: row.id,
          err: errorMessage(err),
        }),
      )
    }
    if (row.status === 'running' || row.status === 'preparing') this.store.update(row.id, { status: 'idle' })
    this.emitNow(row.id)
  }

  /** Whether the session exists and has not ended. */
  isOpen(sessionId: string): boolean {
    const row = this.store.row(sessionId)
    return !!row && !isFinished(row.status)
  }

  /**
   * Whether the worktree of a session may be removed: the session ended, its lane is idle and not closing, its
   * patches are saved (the changes screen reads them once the folder is gone) and no open session works in the
   * same folder. A deleted session's may go.
   */
  worktreeDone(sessionId: string): boolean {
    const row = this.store.row(sessionId)
    if (!row) return true
    if (!isFinished(row.status) || row.patches_at === null || this.closing.has(row.id)) return false
    if (this.lanes.lane(row.id).status !== 'idle') return false
    return !this.store.openFolders().some((f) => f.cwd === row.cwd)
  }

  /** The janitor removed the session's worktree: the next turn of a reopened session makes it again. */
  worktreeRemoved(sessionId: string): void {
    this.ready.delete(sessionId)
  }

  /** The bot was deleted: its open sessions end. */
  botDeleted(botId: string): void {
    for (const row of this.store.open(botId)) this.finish(row, 'cancelled', row.result_summary)
  }

  /** Steps of the session (its plan's or its own) changed. */
  stepsChanged(sessionId: string): void {
    const row = this.store.row(sessionId)
    if (!row) return
    this.cards.sync(row)
    this.emitNow(sessionId)
  }

  /** Starts the session of a plan approved to run in one (`PlanSessions.start`). */
  startForPlan(plan: Plan): { sessionId: string; text: string } | { error: string } | null {
    const bot = this.bot(plan.botId)
    if (!bot) return null
    const project = plan.projectId ? this.deps.projects.find(plan.projectId) : null
    try {
      const session = this.open({
        bot,
        originConversationId: plan.conversationId,
        title: plan.title,
        goal: plan.summary,
        plan,
        projectId: plan.projectId,
        repo: project?.repos.length === 1 ? (project.repos[0] as string) : null,
        folder: plan.folder,
        turnId: null,
        model: plan.model,
      })
      return {
        sessionId: session.id,
        text:
          `It runs in the work session "${session.title}" (${session.id}), in parallel with this chat: do not ` +
          'do the work here. Its result comes back to this conversation when it ends. Tell the user in one short ' +
          'line; do not repeat the plan, they just approved it.',
      }
    } catch (err) {
      this.deps.log?.('warn', 'plan session not started', { planId: plan.id, err: errorMessage(err) })
      return err instanceof DaemonError ? { error: err.message } : null
    }
  }

  private view(row: SessionRow): WorkSessionView {
    return {
      id: row.id,
      botId: row.bot_id,
      conversationId: row.conversation_id,
      title: row.title,
      goal: row.goal,
      cwd: row.cwd ?? '/workspace',
      projectId: row.project_id,
      planId: row.plan_id,
      repoName: row.repo_name,
      branch: this.branch(row),
      brief: this.cards.brief(row),
    }
  }

  /** The bot's sessions that have not ended, oldest first, with when each last had a message. */
  openOf(botId: string): Array<{ id: string; conversationId: string; title: string; idleSince: number }> {
    return this.store
      .open(botId)
      .sort((a, b) => a.created_at - b.created_at)
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        title: row.title,
        idleSince: this.lastMessageAt(row.conversation_id) ?? row.updated_at,
      }))
  }

  private lastMessageAt(conversationId: string): number | null {
    try {
      return this.deps.store.conversations.get(conversationId).lastMessageAt
    } catch {
      return null
    }
  }

  /** What the agent host reads and writes about sessions. */
  directory(): WorkSessionDirectory {
    return {
      get: (id) => {
        const row = this.store.row(id)
        return row ? this.view(row) : null
      },
      state: (id) => this.lanes.stateText(id),
      laneStatus: (id, status, detail) => this.lanes.setStatus(id, status, detail),
      cliStarted: (id) => this.lanes.cliStarted(id),
      recovery: (id) => this.lanes.recovery(id),
      loadTranscript: (id, laneKey) => this.transcript.load(id, laneKey),
      appendTranscript: (id, laneKey, turnId, message) =>
        this.transcript.append(id, laneKey, turnId, message),
      compactTranscript: (id, laneKey, toSeq, summary, llmCallId) =>
        this.transcript.compact(id, laneKey, toSeq, summary, llmCallId),
      inputSeq: (laneKey) => this.deps.store.settings.get<number>(inputSeqKey(laneKey), 0),
      setInputSeq: (laneKey, seq) => this.deps.store.settings.set(inputSeqKey(laneKey), seq),
      subagents: (id, counts, endedLane) => this.lanes.subagentsChanged(id, counts, endedLane),
      ensureReady: (id) => this.ensureReady(id),
    }
  }

  changes(id: string): Promise<SessionChanges> {
    return this.changeTracker.changes(id)
  }

  onToolStarted(record: { id: string; toolName: string; conversationId: string | null }): void {
    this.changeTracker.onToolStarted(record)
  }

  onToolFinished(id: string): void {
    this.changeTracker.onToolFinished(id)
  }

  /**
   * `session_finish`: the session ends, its lane closes once the running turn ends and the bot gets a turn in
   * the conversation the session started from.
   */
  finishFromLane(row: SessionRow, status: WorkSessionStatus, summary: string): SessionRow {
    const finished = this.finish(row, status, summary)
    this.closing.add(row.id)
    if (this.deps.store.bots.find(row.bot_id)) {
      this.deps.host.enqueueTurn({
        botId: row.bot_id,
        conversationId: row.origin_conversation_id,
        trigger: 'session_finished',
        laneKey: row.bot_id,
        note:
          `[Milibot] Your work session "${row.title}" ended (${STATUS_TEXT[status]}). Its result:\n\n${summary}\n\n` +
          'Tell the user here, briefly.',
      })
    }
    return finished
  }

  /** Titles of the sessions among `ids` (deleted ones left out), for links in text. */
  names(ids: readonly string[]): Array<{ id: string; name: string }> {
    return this.store.names(ids)
  }

  /** The sessions whose conversations are among `conversationIds`. */
  sessionsOfConversations(conversationIds: readonly string[]): Array<{ id: string; conversationId: string }> {
    return this.store.byConversations(conversationIds)
  }

  handlers(): EndpointHandlers<keyof typeof workSessionEndpoints> {
    return {
      listWorkSessions: ({ query }) => this.list(query),
      getWorkSession: ({ params }) => this.detail(params.sessionId),
      stopWorkSession: ({ params }) => this.stopSession(params.sessionId),
      getWorkSessionChanges: ({ params }) => this.changes(params.sessionId),
      getWorkSessionFileDiff: ({ params, query }) =>
        this.changeTracker.fileDiff(params.sessionId, query.path),
      getWorkSessionFileImages: ({ params, query }) =>
        this.changeTracker.fileImages(params.sessionId, query.path),
      deleteWorkSession: ({ params }) => {
        this.deleteSession(params.sessionId)
        return { ok: true as const }
      },
    }
  }
}
