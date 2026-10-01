import { CODEX_IMAGE_MODEL, codexGenerateImages } from '@milibot/agent/cli'
import { ImageGenerationError } from '@milibot/agent/images'
import type { DiscoveredModel } from '@milibot/agent/llm'
import {
  CLI_ENGINE_INFO,
  type CliAuthMode,
  type CliInstallStatus,
  cliModelInfo,
  CODEX_VERSION,
  type LogFn,
} from '@milibot/shared'

import { errorMessage } from '../../../errors'
import { type GuestClient, onVmTransition, type VmController } from '../../vm'
import type { CliLogin } from '../cli-login'
import type { CliEngineHost, CliInstaller, CliSignIn } from './host'
import { INSTALL_CODEX_SCRIPT } from './scripts/install-codex.generated'

const CODEX_REAL = '/usr/local/lib/milibot/codex-real'

const INFO = CLI_ENGINE_INFO.codex

const CODEX_LOGIN: CliLogin = { title: INFO.displayName, command: 'codex login; exec bash', name: 'codex' }

/** `codex-cli 0.159.2` → `0.159.2`. */
export function parseCodexVersion(stdout: string): string | null {
  return /codex-cli\s+(\S+)/.exec(stdout)?.[1] ?? null
}

/** `codex login status` exits 0 once logged in (ChatGPT or API key stored by `codex login`). */
export const CODEX_LOGIN_STATUS_CMD = 'codex login status'

type Guest = Pick<GuestClient, 'exec'>

export interface CodexInstallerDeps {
  vm: Pick<VmController, 'status' | 'subscribe' | 'runningGuest'>
  /** Whether any provider of the workspace runs on Codex. */
  needed: () => boolean
  log: LogFn
}

/**
 * The Codex CLI in the VM: installed (or updated to `CODEX_VERSION`) on demand, when a Codex provider
 * exists and the VM is running. One install at a time; the last failure is kept for the settings.
 */
export class CodexInstaller implements CliInstaller {
  private installing: Promise<CliInstallStatus> | null = null
  private error: string | null = null
  private version: string | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: CodexInstallerDeps) {}

  /** Installs when the VM comes up with a Codex provider configured. */
  start(): void {
    this.unsubscribe = onVmTransition(this.deps.vm, {
      up: () => void this.ensure(),
      down: () => {
        this.version = null
      },
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Before a Codex process starts: installs (or waits for the install) when needed; throws when it failed. */
  async ready(): Promise<void> {
    if (this.version === CODEX_VERSION && !this.installing) return
    const status = await this.install()
    if (status.version !== CODEX_VERSION)
      throw new Error(`Codex could not be installed in the VM${status.error ? `: ${status.error}` : ''}`)
  }

  /** Installs in the background when needed and not done yet; never rejects. */
  async ensure(): Promise<void> {
    if (!this.deps.needed() || this.deps.vm.status().state !== 'running') return
    if (this.version === CODEX_VERSION) return
    await this.install().catch(() => undefined)
  }

  async status(): Promise<CliInstallStatus> {
    if (!this.installing && this.deps.vm.status().state === 'running' && this.version === null) {
      this.version = await this.readVersion(this.deps.vm.runningGuest()).catch(() => null)
    }
    return {
      version: this.version,
      expected: CODEX_VERSION,
      installing: this.installing !== null,
      error: this.error,
    }
  }

  install(): Promise<CliInstallStatus> {
    this.installing ??= this.run().finally(() => {
      this.installing = null
    })
    return this.installing
  }

  private async run(): Promise<CliInstallStatus> {
    if (this.deps.vm.status().state !== 'running') {
      this.error = 'The workspace VM is not running'
      return this.snapshot(false)
    }
    try {
      const result = await this.deps.vm.runningGuest().exec({
        user: 'root',
        cmd: INSTALL_CODEX_SCRIPT,
        cwd: '/',
        env: { CODEX_VERSION, CODEX_REAL },
        timeoutMs: 10 * 60_000,
      })
      if (result.code !== 0) throw new Error(result.stderr.trim().slice(-1500) || `exit code ${result.code}`)
      this.version = parseCodexVersion(result.stdout)
      this.error = null
      if (result.stdout.includes('CODEX=installed'))
        this.deps.log('info', 'codex installed in the VM', { version: this.version })
    } catch (err) {
      this.error = errorMessage(err)
      this.deps.log('warn', 'codex install failed', { err: this.error })
    }
    return this.snapshot(false)
  }

  private snapshot(installing: boolean): CliInstallStatus {
    return { version: this.version, expected: CODEX_VERSION, installing, error: this.error }
  }

  private async readVersion(guest: Guest): Promise<string | null> {
    const result = await guest.exec({ user: 'agent', cmd: `${CODEX_REAL} --version`, timeoutMs: 20_000 })
    return result.code === 0 ? parseCodexVersion(result.stdout) : null
  }
}

/** Variable the API key of a Codex provider reaches the process in (never written to the VM's disk). */
const CODEX_KEY_ENV = 'MILIBOT_OPENAI_KEY'
const OPENAI_API_URL = 'https://api.openai.com/v1'

/**
 * How a Codex provider signs in: subscription mode uses the login done in the VM (nothing passed); API-key
 * and gateway modes point the thread at a provider of their own that reads the key from the environment.
 */
function codexProviderSetup(mode: CliAuthMode, secret: string | null, baseUrl: string | null): CliSignIn {
  if (mode === 'subscription') return { env: {}, config: {} }
  return {
    env: secret ? { [CODEX_KEY_ENV]: secret } : {},
    config: {
      model_provider: 'milibot',
      'model_providers.milibot': {
        name: mode === 'api_key' ? 'OpenAI' : 'Gateway',
        base_url: (mode === 'auth_token' && baseUrl) || OPENAI_API_URL,
        env_key: CODEX_KEY_ENV,
        wire_api: 'responses',
      },
    },
  }
}

/** The Codex catalog of `CODEX_VERSION`, with OpenAI's prices. */
function codexCatalog(): DiscoveredModel[] {
  return INFO.models.map((m) => ({
    kind: 'chat' as const,
    modelId: m.id,
    displayName: m.displayName,
    supportsTools: true,
    supportsVision: true,
    contextWindow: m.contextWindow,
    maxOutputTokens: null,
    efforts: [...m.efforts],
    defaultEffort: null,
    dimensions: null,
    priceInputPerMtokUsd: m.input ?? null,
    priceOutputPerMtokUsd: m.output ?? null,
    priceCacheReadPerMtokUsd: m.cacheRead ?? null,
    priceCacheWritePerMtokUsd: m.input ?? null,
    pricePerRequestUsd: null,
    enabled: true,
    source: 'builtin' as const,
  }))
}

export const codexHost: CliEngineHost = {
  engine: 'codex',
  defaultModel: INFO.defaultModel,
  models: INFO.models,
  catalogModels: codexCatalog,
  lightModel: (configured) => configured ?? INFO.lightModel,
  efforts: (model) => cliModelInfo('codex', model)?.efforts ?? null,
  signIn: codexProviderSetup,
  login: CODEX_LOGIN,
  loggedIn: async (guest) =>
    (await guest.exec({ user: 'agent', cmd: CODEX_LOGIN_STATUS_CMD, timeoutMs: 20_000 })).code === 0,
  // The plan comes with the rate limits (`planType`), never from a CLI call.
  plan: 'quota',
  // Codex draws with the ChatGPT subscription: its image model is there from the start.
  imageModel: {
    kind: 'image',
    modelId: CODEX_IMAGE_MODEL,
    displayName: 'ChatGPT images',
    supportsTools: false,
    supportsVision: true,
  },
  async test(guest, provider) {
    const result = await guest.exec({
      user: 'agent',
      cmd: `${CODEX_REAL} --version && ${CODEX_LOGIN_STATUS_CMD}`,
      timeoutMs: 30_000,
    })
    const installed = parseCodexVersion(result.stdout) !== null
    const needsLogin = provider.authMode === 'subscription' && result.code !== 0
    return {
      ok: installed && (result.code === 0 || provider.authMode !== 'subscription'),
      error: !installed
        ? 'Codex is not installed in the VM'
        : needsLogin
          ? 'Codex is not logged in inside the VM'
          : null,
    }
  },
  createRuntime({ vm, inUse, backend, lightModel, log }) {
    const installer = new CodexInstaller({ vm, needed: inUse, log })
    return {
      name: 'codex',
      start: () => installer.start(),
      stop: () => installer.stop(),
      prepare: () => installer.ready(),
      providersChanged: () => void installer.ensure(),
      installer,
      async generateImages(bot, providerId, job) {
        const running = backend()
        const resolved = await lightModel(bot, providerId)
        if (!running || resolved.kind !== 'cli' || resolved.engine !== 'codex')
          throw new ImageGenerationError('provider_error', 'Codex is not available in this workspace')
        return codexGenerateImages(
          running,
          { bot, model: resolved.model, env: resolved.env, providerConfig: resolved.config ?? {}, ...job },
          (message, extra) => log('warn', message, extra),
        )
      },
    }
  },
}
