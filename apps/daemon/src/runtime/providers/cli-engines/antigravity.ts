import { createHash } from 'node:crypto'

import {
  ANTIGRAVITY_AGENTS_DIR,
  ANTIGRAVITY_IMAGE_MODEL,
  ANTIGRAVITY_USAGE_CMD,
  antigravityGenerateImages,
  parseAntigravityUsage,
} from '@milibot/agent/cli'
import { type ImageBytes, ImageGenerationError } from '@milibot/agent/images'
import {
  ANTIGRAVITY_BUILD,
  ANTIGRAVITY_DOWNLOAD_BASE,
  ANTIGRAVITY_DOWNLOADS,
  ANTIGRAVITY_VERSION,
  CLI_ENGINE_INFO,
  cliModelInfo,
} from '@milibot/shared'

import type { GuestClient } from '../../vm'
import { cliCatalogModels } from './catalog'
import type { CliEngineHost } from './host'
import { VmCliInstaller, type VmCliInstallerDeps } from './installer'
import { AGY_MCP_BRIDGE_SCRIPT } from './scripts/agy-mcp-bridge.generated'
import { INSTALL_ANTIGRAVITY_SCRIPT } from './scripts/install-antigravity.generated'

const AGY_REAL = '/usr/local/lib/milibot/agy-real'
const AGY_BRIDGE = '/usr/local/lib/milibot/agy-mcp-bridge.js'
const BRIDGE_SHA = createHash('sha256').update(AGY_MCP_BRIDGE_SCRIPT).digest('hex')

const INFO = CLI_ENGINE_INFO.antigravity

type Guest = Pick<GuestClient, 'exec'>

/**
 * The installed version from `agy --version` and `sha256sum` of the bridge; null unless both are current (an
 * outdated bridge reinstalls like an outdated CLI).
 */
export function parseAntigravityInstall(stdout: string): string | null {
  const version = /^(\d+\.\d+\.\d+)\s*$/m.exec(stdout)?.[1] ?? null
  return version === ANTIGRAVITY_VERSION && stdout.includes(BRIDGE_SHA) ? version : null
}

/** The Antigravity CLI and Milibot's MCP bridge in the VM, kept at `ANTIGRAVITY_VERSION`. */
export class AntigravityInstaller extends VmCliInstaller {
  constructor(deps: VmCliInstallerDeps) {
    super(
      {
        displayName: INFO.displayName,
        expected: ANTIGRAVITY_VERSION,
        script: INSTALL_ANTIGRAVITY_SCRIPT,
        env: {
          AGY_VERSION: ANTIGRAVITY_VERSION,
          AGY_URL: `${ANTIGRAVITY_DOWNLOAD_BASE}/${ANTIGRAVITY_BUILD}`,
          AGY_PATH_AARCH64: ANTIGRAVITY_DOWNLOADS.aarch64.path,
          AGY_SHA_AARCH64: ANTIGRAVITY_DOWNLOADS.aarch64.sha512,
          AGY_PATH_X86_64: ANTIGRAVITY_DOWNLOADS.x86_64.path,
          AGY_SHA_X86_64: ANTIGRAVITY_DOWNLOADS.x86_64.sha512,
          AGY_REAL,
          AGY_BRIDGE,
          AGY_AGENTS_DIR: ANTIGRAVITY_AGENTS_DIR,
        },
        stdin: AGY_MCP_BRIDGE_SCRIPT,
        installedMarker: 'AGY=installed',
        versionCommand: `${AGY_REAL} --version && sha256sum ${AGY_BRIDGE}`,
        parse: parseAntigravityInstall,
      },
      deps,
    )
  }
}

/**
 * Whether agent is signed in, from `/usage`: its quota once signed in, else agy's sign-in prompt (it waits for
 * one, so the command has a timeout). Never reads the token file.
 */
export async function antigravityLoggedIn(guest: Guest): Promise<boolean | null> {
  const result = await guest.exec({ user: 'agent', cmd: ANTIGRAVITY_USAGE_CMD, timeoutMs: 45_000 })
  if (parseAntigravityUsage(result.stdout)) return true
  return /authentication (?:required|failed)/i.test(`${result.stdout}\n${result.stderr}`) ? false : null
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const CONVERSATION = /^[0-9a-f-]{36}$/
const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** Prints `<file> <base64>` per picture `generate_image` saved as `<name>_<timestamp>.<ext>` in the conversation folder. */
const READ_IMAGES_CMD = `cd "$HOME/.gemini/antigravity-cli/brain/$CONVERSATION" || exit 0
printf '%s\\n' "$NAMES" | while IFS= read -r name; do
  for f in "$name"_*; do
    [ -f "$f" ] && printf '%s %s\\n' "$f" "$(base64 -w0 "$f")"
  done
done`

/** The pictures of a drawing turn, read from agent's home in the VM. */
export async function readAntigravityImages(
  guest: Guest,
  conversationId: string,
  names: string[],
): Promise<ImageBytes[]> {
  const safe = names.filter((n) => SAFE_NAME.test(n))
  if (!CONVERSATION.test(conversationId) || !safe.length) return []
  const result = await guest.exec({
    user: 'agent',
    cmd: READ_IMAGES_CMD,
    env: { CONVERSATION: conversationId, NAMES: safe.join('\n') },
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024,
  })
  return result.stdout
    .split('\n')
    .map((line) => line.split(' '))
    .flatMap(([file, data]) => {
      const mediaType = MEDIA_TYPES[file?.split('.').at(-1)?.toLowerCase() ?? '']
      return mediaType && data ? [{ bytes: new Uint8Array(Buffer.from(data, 'base64')), mediaType }] : []
    })
}

export const antigravityHost: CliEngineHost = {
  engine: 'antigravity',
  defaultModel: INFO.defaultModel,
  models: INFO.models,
  catalogModels: () => cliCatalogModels('antigravity'),
  lightModel: (configured) => configured ?? INFO.lightModel,
  efforts: (model) => cliModelInfo('antigravity', model)?.efforts ?? null,
  // Subscription only: the login done in the VM.
  signIn: () => ({ env: {} }),
  login: { title: INFO.displayName, command: 'agy; exec bash', name: 'agy' },
  loggedIn: antigravityLoggedIn,
  plan: 'quota',
  quota: { command: ANTIGRAVITY_USAGE_CMD, parse: parseAntigravityUsage },
  imageModel: {
    kind: 'image',
    modelId: ANTIGRAVITY_IMAGE_MODEL,
    displayName: 'Gemini images',
    supportsTools: false,
    supportsVision: true,
  },
  async test(guest) {
    const installed = await guest.exec({ user: 'agent', cmd: `${AGY_REAL} --version`, timeoutMs: 20_000 })
    if (installed.code !== 0) return { ok: false, error: 'Antigravity is not installed in the VM' }
    const loggedIn = await antigravityLoggedIn(guest)
    return loggedIn
      ? { ok: true, error: null }
      : {
          ok: false,
          error:
            loggedIn === false
              ? 'Antigravity is not signed in inside the VM'
              : 'Antigravity did not answer in the VM',
        }
  },
  createRuntime({ vm, inUse, backend, lightModel, log }) {
    const installer = new AntigravityInstaller({ vm, needed: inUse, log })
    return {
      name: 'antigravity',
      start: () => installer.start(),
      stop: () => installer.stop(),
      prepare: () => installer.ready(),
      providersChanged: () => void installer.ensure(),
      installer,
      async generateImages(bot, providerId, job) {
        const running = backend()
        const resolved = await lightModel(bot, providerId)
        if (!running || resolved.kind !== 'cli' || resolved.engine !== 'antigravity')
          throw new ImageGenerationError('provider_error', 'Antigravity is not available in this workspace')
        return antigravityGenerateImages(
          running,
          {
            bot,
            model: resolved.model,
            env: resolved.env,
            ...job,
            readImages: (conversationId, names) =>
              readAntigravityImages(vm.runningGuest(), conversationId, names),
          },
          (message, extra) => log('warn', message, extra),
        )
      },
    }
  },
}
