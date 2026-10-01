import {
  type Bot,
  type CreateEnvSecretBody,
  type EnvSecret,
  type EnvSecretScope,
  newId,
  type UpdateEnvSecretBody,
} from '@milibot/shared'
import type { z } from 'zod'

import { DaemonError, notFound } from '../../errors'
import type { SecretStore } from '../../secrets/secret-store'
import { maskSecret } from './redaction'

/** Names bots can't override: they would break the VM tooling. */
const RESERVED_ENV_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'DISPLAY',
  'PWD',
  'LANG',
  'MILIBOT_BOT',
]

const ENV_SECRETS_KEY = 'env_secrets'
const envSecretKey = (id: string) => `env.${id}`
/** Temporary secrets live only in this process' memory, at most this long. */
export const TEMPORARY_SECRET_TTL_MS = 12 * 60 * 60_000

/** How a secret reaches a bot: env var + reference, reference only, or reference only for a while. */
type SecretKind = 'env' | 'private' | 'temporary'

export interface BotSecret {
  name: string
  label: string | null
  kind: SecretKind
  value: string
}

interface TemporarySecret {
  name: string
  label: string | null
  scope: EnvSecretScope
  value: string
  expiresAt: number
}

interface EnvSecretRow {
  id: string
  name: string
  scope: EnvSecretScope
  exposeAsEnv: boolean
  label: string | null
  createdAt: number
  updatedAt: number
}

function scopeIncludes(scope: EnvSecretScope, botId: string): boolean {
  return scope === 'all' || scope.includes(botId)
}

export interface EnvSecretsDeps {
  workspaceId: string
  secrets: SecretStore
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  now: () => number
  /** A value, a scope or the temporary secrets changed (the VM's secret files follow). */
  changed: () => void
}

/**
 * Workspace variables and secrets: rows (names, scopes) in the settings, values in the secret store and in this
 * process' memory (for injection and redaction), temporary ones only in memory.
 */
export class EnvSecrets {
  private values = new Map<string, string>()
  private loaded: Promise<void> | null = null
  /** Temporary secrets by `<name>:<scope>`. */
  private temporary = new Map<string, TemporarySecret>()
  private expiryTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: EnvSecretsDeps) {}

  stop(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
  }

  private rows(): EnvSecretRow[] {
    return this.deps.getSetting<EnvSecretRow[]>(ENV_SECRETS_KEY, [])
  }

  private saveRows(rows: EnvSecretRow[]): void {
    this.deps.setSetting(ENV_SECRETS_KEY, rows)
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      const values = new Map<string, string>()
      for (const row of this.rows()) {
        const value = await this.deps.secrets.get(this.deps.workspaceId, envSecretKey(row.id))
        if (value !== null) values.set(row.id, value)
      }
      this.values = values
    })().catch((err: unknown) => {
      this.loaded = null
      throw err
    })
    return this.loaded
  }

  /** Every value known, temporary ones included (for redaction). */
  allValues(): string[] {
    return [...this.values.values(), ...[...this.temporary.values()].map((t) => t.value)]
  }

  private toSecret(row: EnvSecretRow): EnvSecret {
    const value = this.values.get(row.id)
    return { ...row, preview: value ? maskSecret(value) : '' }
  }

  async list(): Promise<EnvSecret[]> {
    await this.load()
    return this.rows().map((row) => this.toSecret(row))
  }

  private validateName(name: string, exceptId?: string): void {
    this.checkName(name)
    if (this.rows().some((r) => r.name === name && r.id !== exceptId))
      throw new DaemonError('conflict', `A variable named ${name} already exists`)
  }

  async create(body: z.output<typeof CreateEnvSecretBody>): Promise<EnvSecret> {
    await this.load()
    this.validateName(body.name)
    const now = this.deps.now()
    const row: EnvSecretRow = {
      id: newId('envSecret'),
      name: body.name,
      scope: body.scope,
      exposeAsEnv: body.exposeAsEnv ?? true,
      label: body.label || null,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.secrets.set(this.deps.workspaceId, envSecretKey(row.id), body.value)
    this.values.set(row.id, body.value)
    this.saveRows([...this.rows(), row])
    this.deps.changed()
    return this.toSecret(row)
  }

  async update(id: string, body: z.output<typeof UpdateEnvSecretBody>): Promise<EnvSecret> {
    await this.load()
    const rows = this.rows()
    const row = rows.find((r) => r.id === id)
    if (!row) throw notFound('variable', id)
    if (body.name !== undefined) this.validateName(body.name, id)
    if (body.value !== undefined) {
      await this.deps.secrets.set(this.deps.workspaceId, envSecretKey(id), body.value)
      this.values.set(id, body.value)
    }
    const next: EnvSecretRow = {
      ...row,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...(body.exposeAsEnv !== undefined ? { exposeAsEnv: body.exposeAsEnv } : {}),
      ...(body.label !== undefined ? { label: body.label || null } : {}),
      updatedAt: this.deps.now(),
    }
    this.saveRows(rows.map((r) => (r.id === id ? next : r)))
    this.deps.changed()
    return this.toSecret(next)
  }

  async delete(id: string): Promise<void> {
    const rows = this.rows()
    if (!rows.some((r) => r.id === id)) throw notFound('variable', id)
    await this.deps.secrets.delete(this.deps.workspaceId, envSecretKey(id))
    this.values.delete(id)
    this.saveRows(rows.filter((r) => r.id !== id))
    this.deps.changed()
  }

  /** Bot deleted: drop it from the scopes (a variable left with no bot is removed). */
  async forgetBot(botId: string): Promise<void> {
    for (const row of this.rows()) {
      if (row.scope === 'all' || !row.scope.includes(botId)) continue
      const scope = row.scope.filter((id) => id !== botId)
      if (scope.length) await this.update(row.id, { scope })
      else await this.delete(row.id)
    }
    for (const [key, secret] of this.temporary)
      if (secret.scope !== 'all' && secret.scope.includes(botId)) this.temporary.delete(key)
    this.deps.changed()
  }

  /** A stored secret by name, whoever can use it (names are unique in the workspace). */
  find(name: string): EnvSecret | null {
    const row = this.rows().find((r) => r.name === name)
    return row ? this.toSecret(row) : null
  }

  /** Name rules of a secret (reserved names); throws a DaemonError. */
  checkName(name: string): void {
    if (RESERVED_ENV_NAMES.includes(name) || name.startsWith('MILIBOT_'))
      throw new DaemonError('validation_failed', `${name} is reserved`)
  }

  /** A temporary secret: usable by reference until the runtime restarts or 12 h pass; never on disk. */
  setTemporary(input: { name: string; label: string | null; scope: EnvSecretScope; value: string }): void {
    this.checkName(input.name)
    const key = `${input.name}:${input.scope === 'all' ? '*' : [...input.scope].sort().join(',')}`
    this.temporary.set(key, { ...input, expiresAt: this.deps.now() + TEMPORARY_SECRET_TTL_MS })
    this.scheduleExpiry()
    this.deps.changed()
  }

  private dropExpired(): boolean {
    const now = this.deps.now()
    let dropped = false
    for (const [key, secret] of this.temporary)
      if (secret.expiresAt <= now) {
        this.temporary.delete(key)
        dropped = true
      }
    return dropped
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    const next = Math.min(...[...this.temporary.values()].map((t) => t.expiresAt))
    if (!Number.isFinite(next)) return
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null
        if (this.dropExpired()) this.deps.changed()
        this.scheduleExpiry()
      },
      Math.max(1000, next - this.deps.now()),
    )
    this.expiryTimer.unref?.()
  }

  /**
   * Every secret the bot can use by reference (`{{secret:NAME}}`, its secret files, list_secrets): stored ones
   * in its scope plus temporary ones; a temporary secret wins over a stored one with the same name.
   */
  secretsFor(bot: Pick<Bot, 'id'>): BotSecret[] {
    this.dropExpired()
    const byName = new Map<string, BotSecret>()
    for (const row of this.rows()) {
      const value = this.values.get(row.id)
      if (value === undefined || !scopeIncludes(row.scope, bot.id)) continue
      byName.set(row.name, {
        name: row.name,
        label: row.label,
        kind: row.exposeAsEnv ? 'env' : 'private',
        value,
      })
    }
    for (const secret of this.temporary.values()) {
      if (!scopeIncludes(secret.scope, bot.id)) continue
      byName.set(secret.name, {
        name: secret.name,
        label: secret.label,
        kind: 'temporary',
        value: secret.value,
      })
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** The variables a bot's processes get as environment (not the reference-only secrets). */
  async envFor(bot: Pick<Bot, 'id'>): Promise<Record<string, string>> {
    await this.load().catch(() => undefined)
    const env: Record<string, string> = {}
    for (const row of this.rows()) {
      const value = this.values.get(row.id)
      if (value !== undefined && row.exposeAsEnv && scopeIncludes(row.scope, bot.id)) env[row.name] = value
    }
    return env
  }
}
