import type {
  Bot,
  CliEngine,
  CliErrorCode,
  CliUsage,
  LlmCallModelUsage,
  LlmCallUsage,
  ReasoningEffort,
  StepFileDiff,
} from '@milibot/shared'

import type { LaneKey } from '../host/lanes'
import type { ToolDefinition } from '../llm/provider'
import type { TokenUsage } from '../llm/usage'
import type { BotMcpServerView, McpOAuthProxyEndpoint } from '../mcp/tools'
import type { ToolName } from '../tools/catalog'
import type { DescribeOptions } from '../tools/describe'
import type { GuestCliBackend } from './backend'
import type { CliMcpConfig } from './mcp-config'
import type { CliTiming } from './process'
import type { CliRotationSettings, GetSetting } from './settings'
import type { CliStartup } from './startup'
import type { CliToolView } from './tools'

/** What a running turn streams back to the host. */
export interface CliTurnIO {
  signal: AbortSignal
  onTextDelta(text: string): void
  /** Ends the current text message (a tool call or a new message follows); `fullText` = the whole message. */
  onTextBoundary(fullText: string | null): void
  /** The model called tools (native or MCP): the text before them was narration. */
  onToolUse?(): void
  /** A tool call's input as it streams: `partialJson` is all the JSON text so far (possibly cut). */
  onToolInputDelta?(toolUseId: string, name: string, partialJson: string): void
  onNativeToolStart(id: string, name: string, input: unknown): void
  /** `diffs`: the files a successful call changed. */
  onNativeToolFinish(id: string, isError: boolean, output: string, diffs: StepFileDiff[]): void
  /** Whether Milibot's MCP server came up for the process (its tools are missing otherwise). */
  onMcpStatus?(connected: boolean, error: string | null): void
  /** Subscription quota update in the engine's own shape (`CliEngineDriver.mergeQuota` reads it). */
  onQuota?(update: unknown): void
  /**
   * The turn is running: until it ends, `send` adds a user message to it (taken in at the engine's next step,
   * or answered right after its reply, still in this turn). False once the turn is over.
   */
  onAcceptingInput?(send: (text: string) => boolean): void
  /** The engine took in a message given to `send`: what comes next answers it too. */
  onInputTaken?(): void
}

/** A model choice's tuning; null/absent = the model's default. */
export interface CliTuning {
  effort?: ReasoningEffort | null
  contextLimit?: number | null
  maxOutputTokens?: number | null
}

export interface CliLaunch {
  bot: Bot
  /** Lane of the bot this process serves (one process and session per lane); defaults to the chat lane. */
  key?: LaneKey
  /** Working directory (default `/workspace`); a stored session resumes only in the folder it started in. */
  cwd?: string
  model: string | null
  tuning?: CliTuning
  /** Provider variables (API key, gateway) and the bot's own (git identity, secrets). */
  env: Record<string, string>
  /** Engine config the provider needs (Codex: `model_provider` in API-key and gateway mode). */
  providerConfig?: Record<string, unknown>
  idleTimeoutMs: number
  /** Milibot rules + persona (+ lane rules), before the memory bootstrap. */
  instructions: string
  /** Replaces the engine's own system prompt (`CliEngineSettings.systemPrompt`); null keeps it. */
  systemPrompt?: string | null
  /** Native tools to switch on (`CliEngineDriver.nativeTools`); null keeps the engine's set. */
  nativeTools?: readonly string[] | null
  /** Read-only helper lane. */
  readOnly?: boolean
  /** Called when a process starts; `fresh` = no session to resume (first start, lost or rotated). */
  startup?: (fresh: boolean) => CliStartup
  /** External MCP servers next to Milibot's (`CliEngineDriver.externalMcp`). */
  externalMcp?: CliMcpConfig | null
  /**
   * Milibot's tools its MCP server offers the lane: an engine whose model never sees MCP schemas (Antigravity)
   * puts them in its prompt.
   */
  mcpTools?: ToolDefinition[]
}

/** What a CLI call cost, as `llm_calls` records it (per model when the engine reports several). */
export interface CliBilling {
  usage: LlmCallUsage
  models?: LlmCallModelUsage[]
}

export interface CliTurnResult {
  /** Set when this turn (re)started the session: whether it was new and what was injected. */
  launched: { fresh: boolean; startup: CliStartup } | null
  ok: boolean
  text: string
  sessionId: string | null
  /** Model the engine reported, else the one asked for, else a name for the engine's default. */
  model: string
  /** Tokens of the turn's own requests (their prompt size feeds the context composition). */
  usage: TokenUsage | null
  billing: CliBilling
  /** Model requests of this turn, and the prompt size of the first and last one. */
  requests: number
  firstContextTokens: number | null
  lastContextTokens: number | null
  durationMs: number | null
  /** How the turn ended: the engine's own status, or `interrupted`, `process_exited`, `error`. */
  subtype: string
  /** Error card code (the app translates it and offers the login when it applies) and the engine's message. */
  error: { code: CliErrorCode; message: string } | null
  /** What was sent besides the input (argv, thread config; never secrets), for `llm_calls`. */
  request: Record<string, unknown>
  /** Engine details of the answer, for `llm_calls`. */
  details: Record<string, unknown>
  events: unknown[]
}

/** A single call without tools, MCP or session (summaries, triage, drawings). */
export interface CliOneShot {
  bot: Bot
  model: string | null
  env: Record<string, string>
  providerConfig?: Record<string, unknown>
  /** null/absent: `low`, narrowed to what the model accepts. */
  effort?: ReasoningEffort | null
  maxOutputTokens?: number | null
  systemPrompt: string
  prompt: string
  signal?: AbortSignal
  /** What the process is for: labelled `<procLabel>-<label>:<bot slug>` in the VM (default `summary`). */
  label?: string
  /** Streams the answer. */
  onText?: (delta: string) => void
}

export interface CliOneShotResult {
  text: string
  /** As in `CliTurnResult`. */
  model: string
  usage: TokenUsage | null
  billing: CliBilling
  durationMs: number | null
  error: string | null
  request: Record<string, unknown>
  details: Record<string, unknown>
}

/** One long-lived process per active bot lane, resumed from its stored session after idling. */
export interface CliSessions {
  runTurn(launch: CliLaunch, input: string, io: CliTurnIO): Promise<CliTurnResult>
  oneShot(request: CliOneShot): Promise<CliOneShotResult>
  /** `force`: SIGKILL at once (the process already ignored a stop). */
  close(key: LaneKey, force?: boolean): Promise<void>
  /** Closes the processes of all the bot's lanes. */
  closeBot(botId: string): Promise<void>
  closeAll(): Promise<void>
  /** Drops the lane's session: the next turn starts a fresh one (with `startup(true)`). */
  rotate(key: LaneKey): Promise<void>
  storedSessionId(key: LaneKey): string | null
  /** Lanes with a live process. */
  activeLanes(): LaneKey[]
}

/** How the prompts name what the engine does natively. */
export interface CliWording {
  /** Its file and command tools ("Bash/Read/Edit/Write"). */
  nativeTools: string
  /** Appended to the rule about using native tools (e.g. which of its own tools to avoid). */
  toolRule: string
  /** How a work session searches and changes files. */
  sessionTools: string
  /** What a helper searches with. */
  helperSearch: string
}

interface CliEngineSettings extends CliRotationSettings {
  /** Replaces the engine's own system prompt; null keeps it. */
  systemPrompt: string | null
}

/** What a session was started with, hashed by `CliEngineDriver.profile`. */
export interface CliProfileInput {
  settings: CliEngineSettings
  /** The lane's own rules when it has them (session, helper), else Milibot rules + persona + team. */
  instructions: string
  mcpTools: ToolDefinition[]
  nativeTools: readonly string[] | null
  /** `CliMcpConfig.fingerprint` of the external servers ('' without any). */
  externalFingerprint: string
}

export type CliLog = (message: string, extra?: Record<string, unknown>) => void

/** A CLI engine: everything engine-specific the host, the prompts and the daemon need (`CLI_ENGINE_DRIVERS`). */
export interface CliEngineDriver {
  id: CliEngine
  /** The engine's name in messages to the user and in logs. */
  displayName: string
  /** Label prefix of its processes in the VM (`<label>:<bot>[:<lane>]`, one-shots `<label>-<purpose>:<bot>`). */
  procLabel: string
  /** Milibot tools it does natively, left out of its MCP list. */
  nativeInMcp: readonly ToolName[]
  wording: CliWording
  /** Model for side work (triage) when the provider names none. */
  lightModel: string
  settings(get: GetSetting): CliEngineSettings
  /** Estimated tokens of the engine's own system prompt + native tools, before a session measures them. */
  estimatedBaseTokens(settings: CliEngineSettings): number
  /** Native tools of a lane; null = the engine has no switch for them. */
  nativeTools(lane: { inSession: boolean; readOnly: boolean }): readonly string[] | null
  /** Identifies what a session was started with: a stored session of another profile is rotated. */
  profile(input: CliProfileInput): string
  /** The bot's external MCP servers in the engine's config shape. */
  externalMcp(
    servers: BotMcpServerView[],
    guestHostAddress: string,
    oauthProxy?: McpOAuthProxyEndpoint,
  ): CliMcpConfig
  /** Activity view of one of its native tool calls; null when the name is not its own. */
  describeTool(name: string, input: unknown, options: DescribeOptions): CliToolView | null
  /** The provider's quota after an `onQuota` update (null: nothing to record). */
  mergeQuota(previous: CliUsage | null, providerId: string, update: unknown, now: number): CliUsage | null
  createSessions(backend: GuestCliBackend, log?: CliLog, timing?: CliTiming): CliSessions
}
