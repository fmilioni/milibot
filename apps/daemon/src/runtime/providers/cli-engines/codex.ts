import { CODEX_IMAGE_MODEL, codexGenerateImages } from '@milibot/agent/cli'
import { ImageGenerationError } from '@milibot/agent/images'
import { CLI_ENGINE_INFO, type CliAuthMode, cliModelInfo, CODEX_VERSION } from '@milibot/shared'

import type { CliLogin } from '../cli-login'
import { cliCatalogModels } from './catalog'
import type { CliEngineHost, CliSignIn } from './host'
import { VmCliInstaller, type VmCliInstallerDeps } from './installer'
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

export type CodexInstallerDeps = VmCliInstallerDeps

/** The Codex CLI in the VM, kept at `CODEX_VERSION` (npm, as root). */
export class CodexInstaller extends VmCliInstaller {
  constructor(deps: CodexInstallerDeps) {
    super(
      {
        displayName: INFO.displayName,
        expected: CODEX_VERSION,
        script: INSTALL_CODEX_SCRIPT,
        env: { CODEX_VERSION, CODEX_REAL },
        installedMarker: 'CODEX=installed',
        versionCommand: `${CODEX_REAL} --version`,
        parse: parseCodexVersion,
      },
      deps,
    )
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

export const codexHost: CliEngineHost = {
  engine: 'codex',
  defaultModel: INFO.defaultModel,
  models: INFO.models,
  catalogModels: () => cliCatalogModels('codex'),
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
