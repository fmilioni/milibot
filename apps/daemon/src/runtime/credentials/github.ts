import {
  type Bot,
  DEFAULT_WORKSPACE_PREFERENCES,
  type ExecResult,
  type GithubStatus,
  type GuestExecRequest,
  type LogFn,
  PREFERENCE_SETTING_KEYS,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import type { SecretStore } from '../../secrets/secret-store'
import { botLinuxUser } from '../vm'
import { GITHUB_SETUP_SCRIPT } from './scripts/github-setup.generated'

const GITHUB_TOKEN_KEY = 'github.token'
const GITHUB_ACCOUNT_KEY = 'github.account'

interface GithubAccount {
  login: string | null
  name: string | null
  tokenKind: GithubStatus['tokenKind']
  expiresAt: number | null
  checkedAt: number
}

/** Fills a commit identity template for one bot. */
export function commitIdentity(template: string, bot: { name: string; slug: string }): string {
  return template.replaceAll('{bot}', bot.name).replaceAll('{slug}', bot.slug)
}

export function githubSetupRequest(input: {
  user: string
  token: string | null
  /** false: leave the gh login as it is (identity-only sync). */
  touchLogin: boolean
  identity: { name: string; email: string } | null
}): GuestExecRequest {
  const mode = !input.touchLogin ? 'keep' : input.token ? 'login' : 'logout'
  return {
    user: input.user,
    cmd: GITHUB_SETUP_SCRIPT,
    cwd: '/tmp',
    env: {
      MILIBOT_GH: mode,
      GIT_NAME: input.identity?.name ?? '',
      GIT_EMAIL: input.identity?.email ?? '',
      GH_PROMPT_DISABLED: '1',
    },
    ...(mode === 'login' && input.token ? { stdin: `${input.token}\n` } : {}),
    timeoutMs: 60_000,
  }
}

function tokenKind(token: string): GithubStatus['tokenKind'] {
  if (token.startsWith('github_pat_')) return 'fine_grained'
  if (token.startsWith('ghp_')) return 'classic'
  return 'other'
}

/** `2026-12-01 00:00:00 UTC` (GitHub's token expiration header). */
export function parseGithubExpiration(value: string | null): number | null {
  if (!value) return null
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|[+-]\d{2}:?\d{2})?/.exec(value.trim())
  if (!m) return null
  const zone = !m[3] || m[3] === 'UTC' ? 'Z' : m[3]
  const at = Date.parse(`${m[1]}T${m[2]}${zone}`)
  return Number.isFinite(at) ? at : null
}

export interface GithubCredentialsDeps {
  workspaceId: string
  secrets: SecretStore
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  now: () => number
  listBots: () => Bot[]
  /** Guest exec while the VM runs; null when it is stopped (never boots it). */
  exec: () => ((request: GuestExecRequest) => Promise<ExecResult>) | null
  fetch: typeof fetch
  redact: (text: string) => string
  log?: LogFn
}

/** The workspace's GitHub token (in the secret store) and the `gh` login and commit identity in the VM. */
export class GithubCredentials {
  private token: string | null | undefined
  private sync: GithubStatus['sync'] = { at: null, ok: null, error: null, users: 0 }
  private syncing: Promise<void> | null = null

  constructor(private readonly deps: GithubCredentialsDeps) {}

  /** The token, also for GitHub API calls made by the daemon (skill imports); never sent to the VM this way. */
  async load(): Promise<string | null> {
    if (this.token === undefined)
      this.token = await this.deps.secrets.get(this.deps.workspaceId, GITHUB_TOKEN_KEY)
    return this.token
  }

  /** The loaded token (for redaction), null before `load`. */
  value(): string | null {
    return this.token ?? null
  }

  async status(): Promise<GithubStatus> {
    const token = await this.load()
    const account = this.deps.getSetting<GithubAccount | null>(GITHUB_ACCOUNT_KEY, null)
    return {
      connected: token !== null,
      login: token ? (account?.login ?? null) : null,
      name: token ? (account?.name ?? null) : null,
      tokenKind: token ? (account?.tokenKind ?? tokenKind(token)) : null,
      expiresAt: token ? (account?.expiresAt ?? null) : null,
      checkedAt: token ? (account?.checkedAt ?? null) : null,
      sync: this.sync,
    }
  }

  /** Asks GitHub who the token belongs to; rejects tokens GitHub refuses. */
  private async check(token: string): Promise<GithubAccount> {
    let res: Response
    try {
      res = await this.deps.fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'Milibot',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      throw new DaemonError('validation_failed', `Could not reach GitHub: ${errorMessage(err)}`)
    }
    if (res.status === 401 || res.status === 403)
      throw new DaemonError('validation_failed', 'GitHub rejected this token')
    if (!res.ok) throw new DaemonError('validation_failed', `GitHub answered HTTP ${res.status}`)
    const user = (await res.json()) as { login?: string; name?: string | null }
    return {
      login: user.login ?? null,
      name: user.name ?? null,
      tokenKind: tokenKind(token),
      expiresAt: parseGithubExpiration(res.headers.get('github-authentication-token-expiration')),
      checkedAt: this.deps.now(),
    }
  }

  async setToken(token: string): Promise<GithubStatus> {
    const account = await this.check(token)
    await this.deps.secrets.set(this.deps.workspaceId, GITHUB_TOKEN_KEY, token)
    this.token = token
    this.deps.setSetting(GITHUB_ACCOUNT_KEY, account)
    await this.syncVm({ touchLogin: true })
    return this.status()
  }

  async deleteToken(): Promise<GithubStatus> {
    await this.deps.secrets.delete(this.deps.workspaceId, GITHUB_TOKEN_KEY)
    this.token = null
    this.deps.setSetting(GITHUB_ACCOUNT_KEY, null)
    await this.syncVm({ touchLogin: true })
    return this.status()
  }

  private identity(bot: Pick<Bot, 'name' | 'slug'>): { name: string; email: string } {
    const nameTemplate = this.deps.getSetting<string>(
      PREFERENCE_SETTING_KEYS.commitName,
      DEFAULT_WORKSPACE_PREFERENCES.commitName,
    )
    const emailTemplate = this.deps.getSetting<string>(
      PREFERENCE_SETTING_KEYS.commitEmail,
      DEFAULT_WORKSPACE_PREFERENCES.commitEmail,
    )
    return { name: commitIdentity(nameTemplate, bot), email: commitIdentity(emailTemplate, bot) }
  }

  /** Git author/committer of a bot's commits (also for the CLI engines, which run as `agent`). */
  gitEnv(bot: Pick<Bot, 'name' | 'slug'>): Record<string, string> {
    const { name, email } = this.identity(bot)
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    }
  }

  /** VM ready or bot provisioned: nothing to do until a token is configured. */
  async syncIfConnected(bots?: Bot[]): Promise<void> {
    if (await this.load()) await this.syncVm({ touchLogin: true, ...(bots ? { bots } : {}) })
  }

  /**
   * Logs `gh` in (or out) for `agent` and every bot user and sets each bot's commit identity (`bots`: only
   * those, without touching `agent` or the reported sync). Runs one at a time.
   */
  syncVm(options: { touchLogin: boolean; bots?: Bot[] }): Promise<void> {
    const run = async () => {
      const exec = this.deps.exec()
      if (!exec) return
      const token = await this.load()
      const bots = options.bots ?? this.deps.listBots()
      const targets = [
        ...(options.bots ? [] : [{ user: 'agent', identity: null }]),
        ...bots.map((bot) => ({ user: botLinuxUser(bot.slug), identity: this.identity(bot) })),
      ]
      const errors: string[] = []
      let users = 0
      for (const target of targets) {
        try {
          const result = await exec(githubSetupRequest({ ...target, token, touchLogin: options.touchLogin }))
          if (result.code === 0) users++
          else errors.push(`${target.user}: ${this.deps.redact(result.stderr.trim()).slice(0, 300)}`)
        } catch (err) {
          errors.push(`${target.user}: ${this.deps.redact(errorMessage(err))}`)
        }
      }
      if (options.bots) return
      this.sync = { at: this.deps.now(), ok: errors.length === 0, error: errors[0] ?? null, users }
      if (errors.length) this.deps.log?.('warn', 'GitHub setup failed for some VM users', { errors })
    }
    const previous = this.syncing ?? Promise.resolve()
    const next = previous.then(run, run)
    this.syncing = next.finally(() => {
      if (this.syncing === next) this.syncing = null
    })
    return next
  }
}
