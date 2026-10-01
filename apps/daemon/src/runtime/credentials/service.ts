import {
  type Bot,
  type CreateEnvSecretBody,
  type credentialEndpoints,
  type EnvSecret,
  type EnvSecretScope,
  type GuestExecRequest,
  type LogFn,
  redactSecrets,
  type UpdateEnvSecretBody,
} from '@milibot/shared'
import type { z } from 'zod'

import { errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { SecretStore } from '../../secrets/secret-store'
import { botLinuxUser, isVmRunning, type VmController, whenVmRunning } from '../vm'
import type { SearchEndpoints } from '../web'
import { type BotSecret, EnvSecrets } from './env-secrets'
import { GithubCredentials } from './github'
import { SecretFiles, secretsDir } from './secret-files'
import { SshKey } from './ssh'
import { WebSearchKey } from './web-search'

export interface CredentialDeps {
  workspaceId: string
  workspaceName: () => string
  secrets: SecretStore
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  now: () => number
  listBots: () => Bot[]
  /** Reached only while it runs (never booted for credentials). */
  vm: Pick<VmController, 'status' | 'subscribe' | 'runningGuest'>
  /** Linux user whose shell reads the bot's secret files (`agent` for bots on a CLI engine). */
  secretFileOwner?: (bot: Bot) => string
  fetch?: typeof fetch
  /** Tests point the search APIs at a local server. */
  webSearchEndpoints?: SearchEndpoints
  log?: LogFn
}

/**
 * GitHub token, web search key, "variables and secrets" and the VM's SSH key. Secret values live in the secret
 * store (and in this process' memory for injection and redaction), never in SQLite.
 */
export class CredentialService {
  readonly github: GithubCredentials
  readonly webSearch: WebSearchKey
  readonly envSecrets: EnvSecrets
  readonly ssh: SshKey
  private readonly files: SecretFiles
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: CredentialDeps) {
    const { vm } = deps
    const exec = () =>
      isVmRunning(vm) ? (request: GuestExecRequest) => vm.runningGuest().exec(request) : null
    const redactText = (text: string) => this.redact(text)
    const settings = { getSetting: deps.getSetting, setSetting: deps.setSetting }
    const fetchFn = deps.fetch ?? fetch
    this.github = new GithubCredentials({
      ...settings,
      workspaceId: deps.workspaceId,
      secrets: deps.secrets,
      now: deps.now,
      listBots: deps.listBots,
      exec,
      fetch: fetchFn,
      redact: redactText,
      log: deps.log,
    })
    this.webSearch = new WebSearchKey({
      ...settings,
      workspaceId: deps.workspaceId,
      secrets: deps.secrets,
      now: deps.now,
      fetch: fetchFn,
      endpoints: deps.webSearchEndpoints,
    })
    this.envSecrets = new EnvSecrets({
      ...settings,
      workspaceId: deps.workspaceId,
      secrets: deps.secrets,
      now: deps.now,
      changed: () => void this.syncSecretFiles().catch(() => undefined),
    })
    this.files = new SecretFiles({
      ...settings,
      listBots: deps.listBots,
      secretsFor: (bot) => this.envSecrets.secretsFor(bot),
      owner: deps.secretFileOwner ?? ((bot) => botLinuxUser(bot.slug)),
      ready: () => this.envSecrets.load(),
      exec,
      redact: redactText,
      log: deps.log,
    })
    this.ssh = new SshKey({ ...settings, workspaceName: deps.workspaceName, exec, log: deps.log })
  }

  async start(): Promise<void> {
    await Promise.all([this.github.load(), this.webSearch.load(), this.envSecrets.load()]).catch(
      (err: unknown) => this.deps.log?.('warn', 'credentials unavailable', { err: errorMessage(err) }),
    )
    this.unsubscribe = whenVmRunning(this.deps.vm, () => {
      void this.github.syncIfConnected().catch(() => undefined)
      void this.syncSecretFiles().catch(() => undefined)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.envSecrets.stop()
  }

  /** Every secret value this service knows, temporary ones included (for redaction). */
  secretValues(): string[] {
    return [this.github.value(), this.webSearch.value(), ...this.envSecrets.allValues()].filter(
      (value): value is string => !!value,
    )
  }

  redact<T>(value: T): T {
    const values = this.secretValues()
    return values.length ? redactSecrets(value, values) : value
  }

  /**
   * Environment of a bot's processes (bash tool, CLI engines): its variables (not the reference-only
   * secrets), its commit identity and where its secret files are. Values are never listed to the bot.
   */
  async botEnv(bot: Bot): Promise<Record<string, string>> {
    return {
      ...this.github.gitEnv(bot),
      MILIBOT_SECRETS_DIR: secretsDir(bot.slug),
      ...(await this.envSecrets.envFor(bot)),
    }
  }

  secretsFor(bot: Pick<Bot, 'id'>): BotSecret[] {
    return this.envSecrets.secretsFor(bot)
  }

  findSecret(name: string): EnvSecret | null {
    return this.envSecrets.find(name)
  }

  checkSecretName(name: string): void {
    this.envSecrets.checkName(name)
  }

  createEnvSecret(body: z.output<typeof CreateEnvSecretBody>): Promise<EnvSecret> {
    return this.envSecrets.create(body)
  }

  updateEnvSecret(id: string, body: z.output<typeof UpdateEnvSecretBody>): Promise<EnvSecret> {
    return this.envSecrets.update(id, body)
  }

  setTemporarySecret(input: {
    name: string
    label: string | null
    scope: EnvSecretScope
    value: string
  }): void {
    this.envSecrets.setTemporary(input)
  }

  syncSecretFiles(): Promise<void> {
    return this.files.sync()
  }

  forgetBot(botId: string): Promise<void> {
    return this.envSecrets.forgetBot(botId)
  }

  /** A bot's user now exists in the VM: its `gh` login, commit identity and secret files. */
  botProvisioned(bot: Bot): void {
    void this.github.syncIfConnected([bot]).catch(() => undefined)
    void this.syncSecretFiles().catch(() => undefined)
  }

  handlers(): EndpointHandlers<keyof typeof credentialEndpoints> {
    const { github, webSearch, envSecrets } = this
    return {
      getGithub: () => github.status(),
      setGithubToken: ({ body }) => github.setToken(body.token),
      deleteGithubToken: () => github.deleteToken(),
      syncGithub: async () => {
        await github.syncVm({ touchLogin: true })
        return github.status()
      },
      getWebSearch: () => webSearch.status(),
      setWebSearchKey: ({ body }) => webSearch.set(body.provider, body.key),
      deleteWebSearchKey: () => webSearch.delete(),
      listEnvSecrets: () => envSecrets.list(),
      createEnvSecret: ({ body }) => envSecrets.create(body),
      updateEnvSecret: ({ params, body }) => envSecrets.update(params.secretId, body),
      deleteEnvSecret: async ({ params }) => {
        await envSecrets.delete(params.secretId)
        return { ok: true as const }
      },
      getSshKey: () => this.ssh.info(),
    }
  }
}
