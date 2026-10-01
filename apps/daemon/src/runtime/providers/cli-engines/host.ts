import type { AgentHost, ResolvedModel } from '@milibot/agent'
import type { GuestCliBackend } from '@milibot/agent/cli'
import type { ImageResult } from '@milibot/agent/images'
import type { DiscoveredModel } from '@milibot/agent/llm'
import type {
  Bot,
  CliAuthMode,
  CliEngine,
  CliInstallStatus,
  CreateProviderModelBody,
  ImageAspect,
  LogFn,
  Provider,
} from '@milibot/shared'

import type { Component } from '../../composition'
import type { GuestClient, VmController } from '../../vm'
import type { WorkspaceStore } from '../../workspace-store'
import type { CliLogin } from '../cli-login'

interface CliModelInfo {
  id: string
  displayName: string
  contextWindow: number
  efforts: readonly string[]
}

/** What a lane's process gets from the provider's sign-in: variables and engine config (never on disk). */
export interface CliSignIn {
  env: Record<string, string>
  config?: Record<string, unknown>
}

interface CliTestResult {
  ok: boolean
  error: string | null
}

/** Pictures drawn through an engine's own image tool (the provider's subscription). */
export interface CliImageJob {
  prompt: string
  count: number
  aspect: ImageAspect
  transparent: boolean
  referencePaths: string[]
  signal: AbortSignal
}

interface CliEngineRuntimeDeps {
  vm: VmController
  store: WorkspaceStore
  host: Pick<AgentHost, 'enqueueTurn'>
  /** Whether a provider of this engine exists. */
  inUse: () => boolean
  /** The engine's backend (null without CLI engines, e.g. tests). */
  backend: () => GuestCliBackend | null
  /** The provider's light model, resolved with the bot's variables (drawing turns). */
  lightModel: (bot: Bot, providerId: string) => Promise<ResolvedModel>
  log: LogFn
}

/** The CLI Milibot installs in the VM (engines with `needsInstall`). */
export interface CliInstaller {
  status(): Promise<CliInstallStatus>
  /** Installs (or waits for the install running); never rejects. */
  install(): Promise<CliInstallStatus>
}

/** What an engine does inside the runtime: work before its processes, its installer, its own tools. */
export interface CliEngineRuntime extends Component {
  /** Before every process of the engine (Codex waits for its CLI to be installed in the VM). */
  prepare?(): Promise<void>
  /** A provider was created or changed. */
  providersChanged?(): void
  installer?: CliInstaller
  generateImages?(bot: Bot, providerId: string, job: CliImageJob): Promise<ImageResult>
}

/**
 * The daemon's side of a CLI engine (`CliEngineDriver` is the agent's): how its providers resolve, sign in, log
 * in and are checked, and what it adds to the runtime. One per engine in `CLI_ENGINE_HOSTS`.
 */
export interface CliEngineHost {
  engine: CliEngine
  defaultModel: string
  models: readonly CliModelInfo[]
  /** The provider's model list in the settings. */
  catalogModels(): DiscoveredModel[]
  /** The model for side work (triage, summaries); `configured` is the provider's light model. */
  lightModel(configured: string | null): string
  efforts(model: string | null): readonly string[] | null
  signIn(mode: CliAuthMode, secret: string | null, baseUrl: string | null): CliSignIn
  login: CliLogin
  /** Whether the agent account is logged in; null when the CLI did not answer. */
  loggedIn(guest: Pick<GuestClient, 'exec'>): Promise<boolean | null>
  /** Whether a bot's own account logged in instead (engines with `detectsWrongAccount`). */
  loggedInElsewhere?(guest: Pick<GuestClient, 'exec'>, slugs: string[]): Promise<boolean>
  /** Where the account plan comes from: the CLI (command + parser) or the quota updates themselves. */
  plan: { command: string; parse(stdout: string): string | null } | 'quota'
  /**
   * For engines whose turns stream no quota: the CLI command that prints it, and its output as the update
   * `CliEngineDriver.mergeQuota` takes (null when unusable). Read after turns and usage views, throttled.
   */
  quota?: { command: string; parse(stdout: string): unknown }
  /** An image model every new provider gets, drawn with the subscription only. */
  imageModel?: CreateProviderModelBody
  /** The settings' "Test": the CLI answers and, with the subscription, the agent account is logged in. */
  test(guest: Pick<GuestClient, 'exec'>, provider: Pick<Provider, 'authMode'>): Promise<CliTestResult>
  createRuntime(deps: CliEngineRuntimeDeps): CliEngineRuntime
}
