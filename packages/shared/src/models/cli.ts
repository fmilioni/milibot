import { z } from 'zod'

import { endpoint } from '../http/endpoint'
import { ANTIGRAVITY_MODELS } from './antigravity'
import { CLAUDE_CODE_MODELS } from './claude-code'
import { CODEX_MODELS } from './codex'
import type { ProviderType } from './providers'
import type { ReasoningEffort } from './reasoning'

/** Providers whose bots run as a coding CLI inside the VM (one process per lane) instead of the native loop. */
export const CLI_ENGINES = ['claude_code', 'codex', 'antigravity'] as const satisfies readonly ProviderType[]
export type CliEngine = (typeof CLI_ENGINES)[number]

export function isCliEngine(type: string | null | undefined): type is CliEngine {
  return (CLI_ENGINES as readonly string[]).includes(type ?? '')
}

/** The subscription login in the VM, an API key, or a gateway token. */
export const CliAuthMode = z.enum(['subscription', 'api_key', 'auth_token'])
export type CliAuthMode = z.infer<typeof CliAuthMode>

/** A model of a CLI engine's fixed catalog; prices (US$ per 1M tokens) when the engine reports no cost. */
export interface CliModel {
  id: string
  displayName: string
  contextWindow: number
  efforts: readonly ReasoningEffort[]
  input?: number
  cacheRead?: number
  output?: number
}

/**
 * What the app, the daemon and the agent know about a CLI engine besides its code. Names in it are brands and
 * what the CLI itself shows (never translated); the app words everything else around them.
 */
export interface CliEngineInfo {
  displayName: string
  /** Brand of the account the subscription login uses ("your Claude account"). */
  account: string
  /** Company whose API key the engine takes ("Anthropic API key"). */
  vendor: string
  keyPlaceholder: string
  /** The option the user picks in the CLI's own login screen. */
  loginOption: string
  models: readonly CliModel[]
  defaultModel: string
  /** Model for side work (summaries, triage) when the provider names none. */
  lightModel: string
  authModes: readonly CliAuthMode[]
  /** Milibot installs the CLI in the VM itself (install status and retry in the settings). */
  needsInstall: boolean
  /** Its login status tells a login made from a bot's own terminal instead of the shared agent account. */
  detectsWrongAccount: boolean
  /** Draws pictures with the subscription (an image model every new provider gets). */
  subscriptionImages: boolean
  /** Can replace its own system prompt with Milibot's compact one (`CliSettings.compactSystemPrompt`). */
  compactSystemPrompt: boolean
}

export const CLI_ENGINE_INFO: Record<CliEngine, CliEngineInfo> = {
  claude_code: {
    displayName: 'Claude Code',
    account: 'Claude',
    vendor: 'Anthropic',
    keyPlaceholder: 'sk-ant-…',
    loginOption: 'Claude account',
    models: CLAUDE_CODE_MODELS,
    defaultModel: 'sonnet',
    lightModel: 'haiku',
    authModes: ['subscription', 'api_key', 'auth_token'],
    needsInstall: false,
    detectsWrongAccount: true,
    subscriptionImages: false,
    compactSystemPrompt: true,
  },
  codex: {
    displayName: 'Codex',
    account: 'ChatGPT',
    vendor: 'OpenAI',
    keyPlaceholder: 'sk-…',
    loginOption: 'Sign in with ChatGPT',
    models: CODEX_MODELS,
    defaultModel: 'gpt-6.1-sol',
    lightModel: 'gpt-6-luna',
    authModes: ['subscription', 'api_key', 'auth_token'],
    needsInstall: true,
    detectsWrongAccount: false,
    subscriptionImages: true,
    compactSystemPrompt: false,
  },
  antigravity: {
    displayName: 'Antigravity',
    account: 'Google',
    vendor: 'Google',
    keyPlaceholder: 'AIza…',
    loginOption: 'Google OAuth',
    models: ANTIGRAVITY_MODELS,
    defaultModel: 'gemini-3.8-flash',
    lightModel: 'gemini-3.8-flash',
    authModes: ['subscription'],
    needsInstall: true,
    detectsWrongAccount: false,
    subscriptionImages: true,
    compactSystemPrompt: false,
  },
}

/** A model of the engine's catalog (the default one when unset); Claude Code's `[1m]` suffix is ignored. */
export function cliModelInfo(engine: CliEngine, model: string | null | undefined): CliModel | null {
  const info = CLI_ENGINE_INFO[engine]
  const id = (model ?? info.defaultModel).replace(/\[1m\]$/, '')
  return info.models.find((m) => m.id === id) ?? null
}

/** One usage window of a CLI subscription (`five_hour`, `seven_day`, …). */
export const CliUsageWindow = z.object({
  id: z.string(),
  /** 0..1 */
  utilization: z.number().nonnegative(),
  resetsAt: z.number().int().nullable(),
})
export type CliUsageWindow = z.infer<typeof CliUsageWindow>

/**
 * Latest subscription quota of a CLI provider: Claude Code's `rate_limit_event`, Codex's rate limits,
 * Antigravity's `/usage` buckets.
 */
export const CliUsage = z.object({
  providerId: z.string(),
  engine: z.enum(CLI_ENGINES),
  /** `allowed`, `allowed_warning`, or `rejected` when the limit was reached. */
  status: z.string(),
  /** Window that limits right now, e.g. `five_hour`. */
  rateLimitType: z.string().nullable(),
  /** When the limiting window renews. */
  resetsAt: z.number().int().nullable(),
  windows: z.array(CliUsageWindow),
  /**
   * Plan of the account (Claude: `subscriptionType` of `claude auth status`, `pro`, `max`…; Codex: `planType`
   * of its rate limits, `plus`, `pro`…; `api` outside subscription mode). Null/absent while unknown.
   */
  plan: z.string().nullable().optional(),
  updatedAt: z.number().int(),
})
export type CliUsage = z.infer<typeof CliUsage>

/** Error card codes of a CLI engine's turn; the card's `params.engine` names the engine. */
export const CLI_ERROR_CODES = [
  'cli_error',
  'cli_usage_limit',
  'cli_unavailable',
  'cli_login_required',
] as const
export type CliErrorCode = (typeof CLI_ERROR_CODES)[number]

function isCliErrorCode(code: string): code is CliErrorCode {
  return (CLI_ERROR_CODES as readonly string[]).includes(code)
}

/** A CLI engine's error card: its generic code and the engine in `params.engine`. */
export function cliErrorOf(
  code: string,
  params?: Readonly<Record<string, string>> | null,
): { code: CliErrorCode; engine: CliEngine } | null {
  if (!isCliErrorCode(code)) return null
  const engine = params?.engine
  return isCliEngine(engine) ? { code, engine } : null
}

/** The engine's login in the VM's agent account. */
export const CliLoginStatus = z.object({
  /** null: unknown (VM not running or the CLI did not answer). */
  loggedIn: z.boolean().nullable(),
  /** The login terminal on the first bot's desktop is running; null when unknown. */
  terminalOpen: z.boolean().nullable(),
  /** Not logged in as agent, but from a bot's own account (engines with `detectsWrongAccount`). */
  loggedInElsewhere: z.boolean(),
})
export type CliLoginStatus = z.infer<typeof CliLoginStatus>

/** The CLI Milibot installs in the VM (engines with `needsInstall`). */
export const CliInstallStatus = z.object({
  /** Version found in the VM (null = not installed or the VM is off). */
  version: z.string().nullable(),
  expected: z.string(),
  installing: z.boolean(),
  /** Last install failure (English, for the log). */
  error: z.string().nullable(),
})
export type CliInstallStatus = z.infer<typeof CliInstallStatus>

/** Session rotation and the fixed context of each session. */
export const CliSettings = z.object({
  /** Idle time after which a bot's session is replaced by a fresh one (the prompt cache has expired). */
  rotateIdleMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60),
  /** Context size of the last request above which the session is replaced by a fresh one. */
  rotateContextTokens: z.number().int().min(10_000).max(1_000_000),
  /** Replaces the engine's own system prompt with Milibot's compact one; absent where unsupported. */
  compactSystemPrompt: z.boolean().optional(),
})
export type CliSettings = z.infer<typeof CliSettings>

/** Which bot's desktop a CLI login terminal opens on (default: the first bot). */
const LoginTerminalBody = z.object({ botId: z.string().optional() })
const LoginTerminal = z.object({ botId: z.string() })

const EngineParams = z.object({ engine: z.enum(CLI_ENGINES) })

export const cliEndpoints = {
  /** Latest subscription quota of each CLI provider that reported one. */
  getCliUsage: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/cli/usage',
    response: z.array(CliUsage),
  }),
}

/** One set for every engine; an engine without the capability answers `unsupported`. */
export const cliEngineEndpoints = {
  /** The engine's login as `agent` in the running VM (never boots it), plus the login terminal's state. */
  getCliLoginStatus: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/cli/:engine/login',
    params: EngineParams,
    response: CliLoginStatus,
  }),
  /** Opens the engine's login (as `agent`) in a terminal on a bot's desktop. */
  openCliLoginTerminal: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/cli/:engine/login-terminal',
    params: EngineParams,
    body: LoginTerminalBody,
    response: LoginTerminal,
  }),
  getCliInstall: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/cli/:engine/install',
    params: EngineParams,
    response: CliInstallStatus,
  }),
  /** Installs (or updates to the pinned version); answers when it is done. */
  installCli: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/cli/:engine/install',
    params: EngineParams,
    response: CliInstallStatus,
  }),
  getCliSettings: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/cli/:engine/settings',
    params: EngineParams,
    response: CliSettings,
  }),
  updateCliSettings: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/cli/:engine/settings',
    params: EngineParams,
    body: CliSettings.partial(),
    response: CliSettings,
  }),
}
