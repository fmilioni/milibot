import type {
  Bot,
  BotActivityAction,
  BotControlAction,
  BotControlOptions,
  BotStatus,
  CliEngine,
  ConversationSummary,
  InstructionFileInfo,
  Language,
  LlmCallModelUsage,
  LlmCallUsage,
  Message,
  MessageKind,
  MessagePayload,
  ModelChoice,
  ReasoningEffort,
  ScreenControl,
  StepFileDiff,
  TurnTrigger,
} from '@milibot/shared'
import type { ContextComposition } from '@milibot/shared'

import type { GuestCliBackend } from './cli/backend'
import type { CliMcpConfig } from './cli/mcp-config'
import type { CliSessionMeta } from './cli/rotation'
import type { CliBootstrap } from './cli/startup'
import type { LaneKind } from './host/lanes'
import type { BlobReader } from './llm/blobs'
import type { ChatMessage, ContentPart, ToolCall } from './llm/messages'
import type { LLMProvider } from './llm/provider'
import type { BotMcpToolSet } from './mcp/tools'
import type { MemoryBackend } from './memory/types'
import type { SkillContext } from './skills/context'

export interface NewAgentMessage {
  conversationId: string
  authorType: 'bot' | 'system'
  authorBotId?: string | null
  kind: MessageKind
  content: string
  payload: MessagePayload | null
  turnId?: string | null
}

export interface LlmCallRecord {
  botId: string | null
  conversationId: string | null
  turnId: string | null
  purpose: string
  providerId: string | null
  providerType: string
  model: string
  request: unknown
  response: unknown
  usage: LlmCallUsage
  contextComposition: ContextComposition | null
  stopReason: string | null
  generationId: string | null
  latencyMs: number | null
  error: string | null
  /** Per-model breakdown (Claude Code `modelUsage`); the call's totals are its sum. */
  models?: LlmCallModelUsage[]
  /** Repository instruction files in the call's context (stored with the request). */
  instructionFiles?: InstructionFileInfo[]
}

export interface ToolCallStart {
  id: string
  llmCallId: string | null
  botId: string
  conversationId: string | null
  turnId: string | null
  toolName: string
  arguments: unknown
  startedAt: number
}

export interface ToolCallFinish {
  status: 'ok' | 'error' | 'cancelled'
  result: unknown
  error: string | null
  screenshotSha: string | null
  finishedAt: number
  /** Patches of the files the call changed. */
  diffs?: StepFileDiff[]
}

export interface ToolResult {
  content: ContentPart[]
  isError?: boolean
  /** Set when the result carries a screenshot of the bot's display. */
  screenshotSha?: string | null
  /**
   * Activity step detail known only after running (the page that was read, the button clicked); `result` is
   * shown when the step is expanded (a helper's report); `files` are the files the call changed.
   */
  activity?: { detail: string; fullDetail?: string; result?: string; files?: StepFileDiff[] }
}

export interface ToolExecContext {
  bot: Bot
  conversationId: string | null
  turnId: string | null
  signal: AbortSignal
  /** Lane of the bot the call runs in (see `lanes.ts`); absent = the chat lane. */
  laneKey?: string
  /**
   * Waits for `wait` without holding a parallel slot (a tool waiting on the user or another bot), the bot
   * shown as working on this tool meanwhile. Absent outside the agent host (e.g. direct calls in tests).
   */
  detach?<T>(wait: Promise<T>): Promise<T>
}

export type ResolvedModel =
  | {
      kind: 'native'
      provider: LLMProvider
      providerId: string | null
      model: string
      /** Context window the lane works with (the model's, capped by the choice's limit); budgets fit it. */
      contextWindow?: number | null
      /** Effort asked for (the choice's, else the model's default); the provider maps it. */
      effort?: ReasoningEffort | null
      /** Output cap of the choice; the provider bounds it by the model's own. */
      maxOutputTokens?: number | null
    }
  | {
      /** Runs as a CLI engine in the VM (one process per lane). */
      kind: 'cli'
      engine: CliEngine
      providerId: string
      model: string | null
      /** The provider's variables in API-key / gateway mode (and the bot's own); no credentials in subscription mode. */
      env: Record<string, string>
      /** Engine config the provider needs (Codex: `model_provider` pointing at the key variable and gateway URL). */
      config?: Record<string, unknown>
      idleTimeoutMs: number
      /** Already narrowed to what the model accepts. */
      effort?: ReasoningEffort | null
      contextLimit?: number | null
      maxOutputTokens?: number | null
    }
  | { kind: 'unavailable'; code: string; reason: string }

export type NativeResolvedModel = Extract<ResolvedModel, { kind: 'native' }>
export type CliResolvedModel = Extract<ResolvedModel, { kind: 'cli' }>
export type RunnableModel = NativeResolvedModel | CliResolvedModel

export function isCliModel(resolved: ResolvedModel): resolved is CliResolvedModel {
  return resolved.kind === 'cli'
}

/** A model as a bot names it from what the user asked ("opus", "gpt-5 mini", "claude-sonnet-5-5"). */
export interface ModelRequest {
  model?: string | null
  effort?: string | null
  /** Context limit: tokens, or "256k" / "1m". */
  context?: string | number | null
  /** Provider name or kind ("Claude Code", "OpenRouter") when the user said where. */
  provider?: string | null
}

export type ModelRequestResult =
  { ok: true; choice: ModelChoice; label: string; notes: string[] } | { ok: false; error: string }

export interface BlobStore extends BlobReader {
  put(bytes: Uint8Array, mediaType: string): Promise<string>
}

/** Reads of the workspace: bots, conversations, messages and preferences. */
export interface WorkspaceReader {
  now(): number
  listBots(): Bot[]
  getBot(id: string): Bot | null
  getConversation(id: string): ConversationSummary | null
  findDirectConversation(botId: string): ConversationSummary | null
  recentMessages(conversationId: string, limit: number): Message[]
  /** A workspace preference (read on every decision, so a change applies to the next one). */
  getSetting<T>(key: string, fallback: T): T
  /** The app's language (workspace preference): what bots write for the user by default. */
  userLanguage(): Language
}

export interface ConfirmationRequest {
  botId: string
  conversationId: string
  action: 'continue_bot_exchange'
  params: Record<string, string>
  reason: string
  data: Record<string, unknown>
}

/** What the host writes into the chat: messages, streamed text, activity, bot status and cards. */
export interface ChatSink {
  /**
   * `sessionId`: the status comes from that work session's lane (the chat lane is idle). `conversationId`: the
   * conversation the shown lane is working on.
   */
  setBotStatus(
    botId: string,
    status: BotStatus,
    detail?: string,
    targetBotId?: string,
    sessionId?: string,
    conversationId?: string,
  ): void
  appendMessage(message: NewAgentMessage): Message
  updateMessage(id: string, patch: { content?: string; payload?: MessagePayload | null }): Message
  /** Removes a message (a bot's narration between tool calls, folded into its activity card). */
  deleteMessage(id: string): void
  emitDelta(conversationId: string, messageId: string, delta: string): void
  emitActivity(action: BotActivityAction): void
  /** Internal (bot↔bot) conversation of two bots, created (and announced) on first use. */
  internalConversation(fromBotId: string, toBotId: string): ConversationSummary
  /** Posts a confirmation card the user approves or rejects; approval runs the daemon's handler of `action`. */
  requestConfirmation(input: ConfirmationRequest): void
}

export type LogLevel = 'info' | 'warn' | 'error'

/** Records of what the host did: LLM and tool calls, finished turns, logs. */
export interface Telemetry {
  recordLlmCall(record: LlmCallRecord): string
  /** Replaces what `recordLlmCall` stored for `id`: a running CLI turn's progress, then its result. */
  updateLlmCall(id: string, record: LlmCallRecord): void
  startToolCall(record: ToolCallStart): void
  finishToolCall(id: string, finish: ToolCallFinish): void
  /** A turn that ran ended (not called for requests dropped before running). */
  turnFinished(info: TurnFinishedInfo): void
  log(level: LogLevel, message: string, extra?: Record<string, unknown>): void
}

/** Which model runs each piece of work. */
export interface ModelResolver {
  /**
   * The model a turn of `bot` runs on: `model` when given (a helper asked for one), else the model its lane
   * was opened with (a work session started on another model), else the bot's own.
   */
  resolveModel(bot: Bot, options?: { laneKey?: string; model?: ModelChoice | null }): Promise<ResolvedModel>
  /** Model of the `memory.summary_model` preference. */
  resolveSummaryModel(bot: Bot): Promise<ResolvedModel>
  /** Cheap model that decides which group members answer a message without mentions. */
  resolveTriageModel(candidates: Bot[]): Promise<ResolvedModel>
  /** The `agents.fallback_model` preference: tried once when the bot's provider fails or its quota ran out. */
  resolveFallbackModel(bot: Bot): Promise<ResolvedModel | null>
  /**
   * A model the user asked for by name (`session_start`, `plan_write`, `subagent`): without `model`, the lane's
   * current model with the effort or context asked for.
   */
  resolveModelRequest(bot: Bot, request: ModelRequest, laneKey?: string): ModelRequestResult
  /** The provider's subscription quota ran out and has not renewed yet (Claude Code, Codex). */
  providerExhausted(providerId: string): boolean
}

/** The tools a bot has and the daemon's side of running them. */
export interface ToolGateway {
  /** Runs a tool the host does not run itself (the daemon's tool providers). */
  executeTool(ctx: ToolExecContext, call: ToolCall): Promise<ToolResult>
  /**
   * The bot's active skills: their catalog in its system prompt and the tool families they enable (tools of
   * other families are neither offered nor run).
   */
  skillContext(bot: Bot, lane: LaneKind): SkillContext
  /** External MCP tools the bot can use on an API provider (enabled servers and tools only). */
  mcpTools(bot: Bot): Promise<BotMcpToolSet>
  /** Display name of an external MCP server by its slug (activity steps). */
  mcpServerName(slug: string): string | null
  /**
   * Input of a `DRAFT_TOOLS` call while the model is still writing it (`partialJson` = the JSON so
   * far, possibly cut anywhere). Throttled by the host; the call itself runs later as usual.
   */
  toolInputDraft(ctx: ToolInputDraftContext, toolName: string, partialJson: string): void
}

/** The CLI engines' side of the workspace. */
export interface CliPort {
  /** Each CLI engine's processes in the VM (its own session ids and MCP tokens); none without a VM. */
  cli: Partial<Record<CliEngine, GuestCliBackend>>
  /** External MCP servers of a CLI engine bot, in that engine's config shape (`CliEngineDriver.externalMcp`). */
  cliMcp(bot: Bot, engine: CliEngine): Promise<CliMcpConfig>
  /** A subscription quota update of a CLI provider, in its engine's shape (`CliEngineDriver.mergeQuota`). */
  cliQuota(providerId: string, engine: CliEngine, update: unknown): void
}

/**
 * State the host keeps across runtime restarts (stored as workspace settings under `HOST_STATE_KEYS` and
 * `cliKeys`; `settingsHostState` maps it onto them).
 */
export interface HostStateStore {
  /** The user paused the bot. */
  paused(botId: string): boolean
  setPaused(botId: string, paused: boolean): void
  cliMeta(engine: CliEngine, laneKey: string): CliSessionMeta | null
  setCliMeta(engine: CliEngine, laneKey: string, meta: CliSessionMeta): void
  cliBootstrap(engine: CliEngine, laneKey: string): CliBootstrap | null
  setCliBootstrap(engine: CliEngine, laneKey: string, bootstrap: CliBootstrap): void
}

export interface ActivePlan {
  id: string
  title: string
  steps: Array<{ id: string; title: string; status: string }>
}

/** A bot's work that outlives a turn, as every one of its conversations sees it. */
export interface BotWorkState {
  /** Work sessions not ended yet. */
  sessions: Array<{ id: string; conversationId: string; title: string }>
  /** Plans awaiting approval, approved or being carried out. */
  plans: Array<{ id: string; title: string; status: string }>
}

/** A request set aside with `after_current_work`, kept across runtime restarts. */
export interface SetAsideEntry {
  id: string
  botId: string
  conversationId: string
  task: string
  waitingOn: string[]
  createdAt: number
  alertedAt: number | null
  /** Turns queued to wake the bot with it. */
  attempts: number
  /** When the turn that woke the bot with it started acting; set on a waiting one = left midway. */
  actedAt: number | null
}

/** Where set-aside requests are kept (the daemon's database). */
export interface SetAsideStore {
  add(entry: { botId: string; conversationId: string; task: string; waitingOn: string[] }): SetAsideEntry
  /** Requests not taken up yet, oldest first; every bot's without `botId`. */
  waiting(botId?: string): SetAsideEntry[]
  /** A turn to wake the bot with it was queued (it stays waiting until that turn runs). */
  markAttempt(id: string): void
  /** The turn that woke the bot with it started acting: from now on it is never woken again. */
  markActed(id: string): void
  /** The turn that woke the bot with it ran. */
  markWoken(id: string): void
  /** The idle watch reported these. */
  markAlerted(ids: string[]): void
  /** Drops the bot's waiting requests: all, one conversation's or one by id. Returns the dropped ones. */
  drop(botId: string, filter?: { conversationId?: string; id?: string }): SetAsideEntry[]
}

/** Work sessions and plans as the lanes see them. */
export interface WorkPort {
  /**
   * The work session a conversation belongs to: its turns run in the session's lane of the bot. `ended`: the
   * session is over, and what still reaches it goes to the conversation it started from.
   */
  workSession(conversationId: string): {
    sessionId: string
    ended?: { originConversationId: string; title: string }
  } | null
  /** Work sessions: what their lanes read and where native turns keep their transcript. */
  workSessions: WorkSessionDirectory
  /** The approved plan a lane is carrying out, so the bots it asks for help can mark the steps they do. */
  activePlan(bot: Bot, laneKey: string, conversationId: string | null): ActivePlan | null
  /** The bot's open sessions and plans in progress, whichever conversation they started in. */
  workState(botId: string): BotWorkState
  setAside: SetAsideStore
}

/** A CLAUDE.md or AGENTS.md of a repository in the VM. */
export interface RepoInstructionFile {
  path: string
  /** Size of the whole file. */
  bytes: number
  /** `content` is the start of the file, cut at a line end (`REPO_INSTRUCTIONS_FILE_MAX`). */
  truncated: boolean
  content: string
  /** The other name in the same folder with the same text (or the same file), left out for this one. */
  sameAs: string[]
}

/** The instruction files of the repositories the bots work in (read in the VM by the daemon). */
export interface RepoInstructionsPort {
  /**
   * The CLAUDE.md/AGENTS.md of each path's repository, in every folder from the repository root down to the
   * path's folder (a file's folder, or the closest existing one), root first, each file once. In one folder,
   * two names that are the same file or have the same text count once (CLAUDE.md). [] outside a repository
   * or while the VM is not running.
   */
  repoInstructions(bot: Bot, paths: string[], signal?: AbortSignal): Promise<RepoInstructionFile[]>
}

/** Callbacks the agent runtime uses to act on the workspace (implemented by the daemon runtime). */
export interface AgentEnvironment
  extends
    WorkspaceReader,
    ChatSink,
    Telemetry,
    ModelResolver,
    ToolGateway,
    CliPort,
    WorkPort,
    RepoInstructionsPort {
  hostState: HostStateStore
  blobs: BlobStore
  memory: MemoryBackend
  /** Knowledge base: the catalog in every context and the documents relevant to each turn. */
  knowledge: KnowledgeContext
  /** Projects: a conversation's current project and what the bots read about it. */
  projects: ProjectDirectory
}

export interface ToolInputDraftContext {
  bot: Bot
  conversationId: string
  turnId: string
  laneKey: string
  /** The model's id for the call (tool_use id); tells apart several calls of the same tool in a turn. */
  toolCallId?: string
}

/** What a bot's context gets from the knowledge base (implemented by the daemon). */
export interface KnowledgeContext {
  /**
   * Fixed block for the cached part of the context: how many general documents (no project) the bot can
   * search and the pinned ones with a one-line summary; '' without documents. Changes only when documents
   * change. Project documents are in the project's block (`ProjectDirectory.block`).
   */
  catalog(bot: Bot): string
  /**
   * Block for the latest input of a turn: documents whose summary is close to `query` and, when enabled,
   * the best excerpts; '' when nothing is relevant. Only general documents and `projectId`'s.
   */
  forTurn(bot: Bot, query: string, signal: AbortSignal, projectId?: string | null): Promise<string>
}

/** Projects of the workspace as the agent host sees them (implemented by the daemon). */
export interface ProjectDirectory {
  /** A project by id, slug or name; `general` for the refs meaning "no project". */
  resolve(ref: string): { project: { id: string; name: string } } | { general: true } | { problem: string }
  /**
   * What the bots read about the project: name, description, repositories, its notes and documents; ''
   * when it no longer exists. `knowledge: false` leaves the documents out (the bot has no knowledge tools).
   */
  block(bot: Bot, projectId: string, options?: { knowledge?: boolean }): string
}

/** A work session as its lanes see it (implemented by the daemon). */
export interface WorkSessionView {
  id: string
  botId: string
  conversationId: string
  title: string
  goal: string
  /** Where the bot works in the VM. */
  cwd: string
  projectId: string | null
  planId: string | null
  repoName: string | null
  branch: string | null
  /** What the bot reads about the session: goal, where it works, its plan (the `session_brief` card). */
  brief: string
}

/** One stored entry of a native session lane's transcript. */
export interface TranscriptEntry {
  seq: number
  message: ChatMessage
}

/** Work sessions for the agent host (implemented by the daemon). */
export interface WorkSessionDirectory {
  get(sessionId: string): WorkSessionView | null
  /**
   * Current state for the input of a session turn (the steps and their status); '' when there is nothing
   * to say.
   */
  state(sessionId: string): string
  /** The lane's status changed (the session follows its lane: running while it works). */
  laneStatus(sessionId: string, status: BotStatus, detail: string | null): void
  /** A fresh CLI session (Claude Code session, Codex thread) started for the lane; returns how many did before. */
  cliStarted(sessionId: string): number
  /** What a fresh CLI session needs to pick the work up: steps, last messages, last actions. */
  recovery(sessionId: string): string
  /** Rolling summary and uncompacted entries of a native lane's transcript, oldest first. */
  loadTranscript(sessionId: string, laneKey: string): { summary: string | null; entries: TranscriptEntry[] }
  /** Stores one entry right after it enters the context; returns its seq. */
  appendTranscript(sessionId: string, laneKey: string, turnId: string | null, message: ChatMessage): number
  /** Entries up to `toSeq` are now covered by `summary`. */
  compactTranscript(
    sessionId: string,
    laneKey: string,
    toSeq: number,
    summary: string,
    llmCallId: string | null,
  ): void
  /** Seq of the last session conversation message already given to the lane (0 = none). */
  inputSeq(laneKey: string): number
  setInputSeq(laneKey: string, seq: number): void
  /** Helpers (`subagent`) of the session running now and started so far; `endedLane`: a helper just ended. */
  subagents(sessionId: string, counts: { running: number; total: number }, endedLane?: string): void
  /**
   * The session's folder exists (made now if the VM was off when the session started); called before each
   * turn of its lanes.
   */
  ensureReady(sessionId: string): Promise<void>
}

/** How a requested turn ended; `cancelled` also covers a request dropped from the queue (stop, bot deleted). */
export type TurnOutcome = 'done' | 'error' | 'cancelled'

export interface TurnFinishedInfo {
  botId: string
  conversationId: string
  turnId: string
  trigger: TurnTrigger
  routineId: string | null
  outcome: TurnOutcome
  /** The bot's text in this turn (empty when it wrote nothing). */
  reply: string
}

export interface TurnRequest {
  botId: string
  conversationId: string
  trigger: TurnTrigger
  /** The turn starts only after this settles (e.g. the new bot's desktop being provisioned). */
  waitFor?: Promise<unknown>
  /** Input for this turn only, not stored in the conversation (e.g. a reply from another bot). */
  note?: string
  /** Bot-to-bot requests this turn answers; its reply goes back to the askers. */
  botRequests?: string[]
  /** Bots waiting on this turn up the ask_bot/message_bot chain (cycle detection). */
  chain?: string[]
  /** Bot-to-bot hops since a user message (depth limit). */
  hops?: number
  /** Routine whose run this turn is (`trigger: 'routine'`). */
  routineId?: string
  /** Lane the turn runs in (see `lanes.ts`); resolved from the conversation when absent. */
  laneKey?: string
  /** Model of this turn instead of the lane's (a helper started on a chosen model). */
  model?: ModelChoice | null
  /**
   * Called once when the turn ends or the request is dropped (routines track their runs with it). `failed`:
   * the turn could not do its work (the model failed or was unavailable, the turn crashed), unlike an `error`
   * outcome that only says its last step failed.
   */
  onFinished?: (outcome: TurnOutcome, failed?: boolean) => void
  /** Called once, before the turn's first tool call runs: what follows may have effects. */
  onActing?: () => void
}

/** One tool-less completion on behalf of a bot, logged in `llm_calls` (e.g. writing a taught procedure). */
export interface WriteTextRequest {
  botId: string
  conversationId: string | null
  /** The turn it works for (its cost shows under that turn). */
  turnId?: string | null
  purpose: string
  system: string
  prompt: string
  /** Image parts sent after the prompt (skipped by the CLI engines, whose one-shots are text only). */
  images?: ContentPart[]
  maxOutputTokens: number
  signal?: AbortSignal
  /** Model to use instead of the bot's summary model (e.g. the document summary preference). */
  model?: ResolvedModel
  onText?: (delta: string) => void
  /** What a CLI engine's one-shot process is for (`CliOneShot.label`). */
  label?: string
}

export interface ScreenState {
  paused: boolean
  control: ScreenControl
  /** A turn is running or waiting in the bot's queue. */
  busy: boolean
}

/**
 * Entry point of the agent runtime inside a workspace runtime process. The daemon notifies it of
 * new messages; it decides which bots take a turn and drives the loop.
 */
export interface AgentHost {
  start(env: AgentEnvironment): Promise<void>
  stop(): Promise<void>
  onMessageCreated(message: Message): void
  enqueueTurn(request: TurnRequest): void
  /** Pause/takeover/resume act on the whole bot; `stop` on the lanes `options` select (all by default). */
  control(botId: string, action: BotControlAction, options?: BotControlOptions): ScreenState
  screenState(botId: string): ScreenState
  /** Runs one tool call on behalf of a bot (pause gating, logging, activity). Used by the MCP server. */
  runTool(botId: string, conversationId: string | null, call: ToolCall, laneKey?: string): Promise<ToolResult>
  /** Whether the lane is a read-only helper's (its tool set is `READ_ONLY_HELPER_TOOLS`). */
  isReadOnlyLane(laneKey: string): boolean
  /** Resolves when the bot has no running or queued turn nor pending compaction (tests, graceful restarts). */
  idle(botId?: string): Promise<void>
  /** Stops the bot's work and its CLI processes (the bot was deleted). */
  forgetBot(botId: string): Promise<void>
  /** Closes a finished work session lane: its CLI process and, when idle, its state. */
  closeLane(laneKey: string): Promise<void>
  /** Holds every queue (daily spend limit): no new turn starts and API turns wait between steps. */
  hold(held: boolean): void
  /** Completion with the bot's cheap model (the summary model), outside any turn. */
  writeText(
    request: WriteTextRequest,
  ): Promise<{ text: string; llmCallId: string | null; stopReason?: string }>
  /** Sends a bot message held while a long bot-to-bot exchange waited for the user; false if it is gone. */
  resumeBotMessage(heldId: string): boolean
}

export function createNoopAgentHost(): AgentHost {
  return {
    async start() {},
    async stop() {},
    onMessageCreated() {},
    enqueueTurn() {},
    control: () => ({ paused: false, control: 'idle', busy: false }),
    screenState: () => ({ paused: false, control: 'idle', busy: false }),
    runTool: async () => ({ content: [{ type: 'text', text: 'agent runtime unavailable' }], isError: true }),
    isReadOnlyLane: () => false,
    idle: async () => {},
    forgetBot: async () => {},
    closeLane: async () => {},
    hold: () => {},
    resumeBotMessage: () => false,
    writeText: async () => {
      throw new Error('agent runtime unavailable')
    },
  }
}
