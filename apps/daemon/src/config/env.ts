import { CloseBehavior, Language } from '@milibot/shared'
import { z } from 'zod'

import { currentHost } from '../host/profile'
import { RUNTIME_ENV } from '../ipc/protocol'
import type { SecretStoreKind } from '../secrets/factory'
import { platformDataRoot, resolveDataRoot } from './paths'

const text = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional())
const flag = z.preprocess((v) => v === '1', z.boolean())
const positiveInt = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : Number(v)),
  z.number().int().positive().optional(),
)

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
type DaemonLogLevel = (typeof LOG_LEVELS)[number]

/**
 * Every `MILIBOT_*` variable the daemon reads (the table in the root CLAUDE.md lists the same names). Nothing
 * else in the daemon reads `process.env` for them; `MILIBOT_DATA_DIR`, `MILIBOT_QEMU_HOME` and `MILIBOT_QEMU_SHARE`
 * reach the platform layer through `Host.env`.
 */
const DaemonEnvSchema = z.object({
  MILIBOT_DATA_DIR: text,
  MILIBOT_SECRET_STORE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['keychain', 'keyring', 'file', 'memory']).optional(),
  ),
  MILIBOT_DAEMON_PORT: positiveInt,
  MILIBOT_LOG_LEVEL: z.preprocess((v) => (v === '' ? undefined : v), z.enum(LOG_LEVELS).default('info')),
  MILIBOT_LOG_REQUESTS: flag,
  MILIBOT_VM_DISABLED: flag,
  MILIBOT_VM_AUTOSTART: z.preprocess((v) => v !== '0', z.boolean()),
  MILIBOT_VM_PORT_FIRST: positiveInt,
  MILIBOT_GOLDEN_IMAGE: text,
  MILIBOT_VM_CLI: text,
  MILIBOT_VM_BUILD: text,
  MILIBOT_QEMU_HOME: text,
  MILIBOT_QEMU_SHARE: text,
  MILIBOT_FAKE_EMBEDDINGS: flag,
  MILIBOT_FAKE_IMAGES: flag,
  MILIBOT_FAKE_LLM: text,
  MILIBOT_BUILTIN_SKILLS: text,
  MILIBOT_DESIGN_ASSETS: text,
})

export type DaemonEnv = z.output<typeof DaemonEnvSchema>

export const DAEMON_ENV_VARS = Object.keys(DaemonEnvSchema.shape) as ReadonlyArray<keyof DaemonEnv>

function parseDaemonEnv(env: NodeJS.ProcessEnv): DaemonEnv {
  const parsed = DaemonEnvSchema.safeParse(env)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  throw new Error(`invalid environment: ${issues}`)
}

/** Where the VM scripts come from; unset fields use the repository's (`findRepoFile`). */
interface VmScriptsConfig {
  cli: string | null
  build: string | null
}

interface CommonConfig {
  dataRoot: string
  /** The platform's data folder, where the golden image is also looked up (see `resolveGoldenImage`). */
  platformDataRoot: string
  logLevel: DaemonLogLevel
  secretStore: SecretStoreKind | null
  goldenImage: string | null
  vmScripts: VmScriptsConfig
}

export interface DaemonConfig extends CommonConfig {
  /** Requested port (null: the previous `daemon.json` port, else a random one). */
  port: number | null
  logRequests: boolean
  vmPortFirst: number
}

export interface RuntimeConfig extends CommonConfig {
  workspaceId: string
  workspaceDir: string
  workspaceName: string
  language: Language
  vmPortBase: number | null
  /** Started by the daemon without a window (a "suspend VM" workspace leaves its VM off until one opens). */
  background: boolean
  closeBehavior: CloseBehavior
  vmDisabled: boolean
  vmAutostart: boolean
  fakeLlm: string | null
  fakeEmbeddings: boolean
  fakeImages: boolean
  builtinSkillsDir: string | null
  designAssetsDir: string | null
}

export const DEFAULT_VM_PORT_FIRST = 24000

function commonConfig(env: NodeJS.ProcessEnv, parsed: DaemonEnv): CommonConfig {
  const host = currentHost(env)
  return {
    dataRoot: resolveDataRoot(host),
    platformDataRoot: platformDataRoot(host),
    logLevel: parsed.MILIBOT_LOG_LEVEL,
    secretStore: parsed.MILIBOT_SECRET_STORE ?? null,
    goldenImage: parsed.MILIBOT_GOLDEN_IMAGE ?? null,
    vmScripts: { cli: parsed.MILIBOT_VM_CLI ?? null, build: parsed.MILIBOT_VM_BUILD ?? null },
  }
}

export function readDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const parsed = parseDaemonEnv(env)
  return {
    ...commonConfig(env, parsed),
    port: parsed.MILIBOT_DAEMON_PORT ?? null,
    logRequests: parsed.MILIBOT_LOG_REQUESTS,
    vmPortFirst: parsed.MILIBOT_VM_PORT_FIRST ?? DEFAULT_VM_PORT_FIRST,
  }
}

/** A runtime process's configuration: the daemon's variables plus the ones the supervisor forks it with. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = parseDaemonEnv(env)
  const workspaceId = env[RUNTIME_ENV.workspaceId]
  const workspaceDir = env[RUNTIME_ENV.workspaceDir]
  if (!workspaceId || !workspaceDir)
    throw new Error('runtime must be forked by the supervisor with workspace env')
  return {
    ...commonConfig(env, parsed),
    workspaceId,
    workspaceDir,
    workspaceName: env[RUNTIME_ENV.workspaceName] || workspaceId,
    language: Language.catch('pt-BR').parse(env[RUNTIME_ENV.language]),
    vmPortBase: Number(env[RUNTIME_ENV.vmPortBase]) || null,
    background: env[RUNTIME_ENV.background] === '1',
    closeBehavior: CloseBehavior.catch('keep_running').parse(env[RUNTIME_ENV.closeBehavior]),
    vmDisabled: parsed.MILIBOT_VM_DISABLED,
    vmAutostart: parsed.MILIBOT_VM_AUTOSTART,
    fakeLlm: parsed.MILIBOT_FAKE_LLM ?? null,
    fakeEmbeddings: parsed.MILIBOT_FAKE_EMBEDDINGS,
    fakeImages: parsed.MILIBOT_FAKE_IMAGES,
    builtinSkillsDir: parsed.MILIBOT_BUILTIN_SKILLS ?? null,
    designAssetsDir: parsed.MILIBOT_DESIGN_ASSETS ?? null,
  }
}
