import type { Bot, ExecResult, GuestExecRequest, LogFn } from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { BotSecret } from './env-secrets'
import { SECRET_FILES_SCRIPT } from './scripts/secret-files.generated'

const SECRETS_ROOT = '/run/milibot/secrets'
/** The VM may hold secret files (tmpfs survives a runtime restart while the VM runs). */
const SECRET_FILES_SETTING = 'secrets.files_written'

export const secretsDir = (slug: string) => `${SECRETS_ROOT}/${slug}`

function secretFilesRequest(
  bots: Array<{ slug: string; owner: string; secrets: BotSecret[] }>,
): GuestExecRequest {
  const lines = bots.flatMap((bot) => [
    ['bot', bot.slug, bot.owner, '', ''].join('\t'),
    ...bot.secrets.map((secret) =>
      ['secret', bot.slug, bot.owner, secret.name, Buffer.from(secret.value, 'utf8').toString('base64')].join(
        '\t',
      ),
    ),
  ])
  return {
    user: 'root',
    cmd: SECRET_FILES_SCRIPT,
    cwd: '/',
    env: { MILIBOT_SECRETS_ROOT: SECRETS_ROOT },
    stdin: lines.length ? `${lines.join('\n')}\n` : '',
    timeoutMs: 30_000,
  }
}

export interface SecretFilesDeps {
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  listBots: () => Bot[]
  secretsFor: (bot: Bot) => BotSecret[]
  /** Linux user whose shell reads the bot's secret files. */
  owner: (bot: Bot) => string
  /** Before writing: the secret values are loaded. */
  ready: () => Promise<void>
  exec: () => ((request: GuestExecRequest) => Promise<ExecResult>) | null
  redact: (text: string) => string
  log?: LogFn
}

/** Mirrors each bot's secrets into the VM's tmpfs secret files (`/run/milibot/secrets/<slug>/<NAME>`). */
export class SecretFiles {
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly deps: SecretFilesDeps) {}

  /**
   * Runs when the VM becomes ready, when a secret changes or expires and for a new bot; without secrets (and
   * none written before) nothing runs. Calls during a sync run it once more afterwards.
   */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    const run = async () => {
      do {
        this.again = false
        await this.write()
      } while (this.again)
    }
    this.running = run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async write(): Promise<void> {
    const exec = this.deps.exec()
    if (!exec) return
    await this.deps.ready().catch(() => undefined)
    const bots = this.deps.listBots().map((bot) => ({
      slug: bot.slug,
      owner: this.deps.owner(bot),
      secrets: this.deps.secretsFor(bot),
    }))
    const any = bots.some((b) => b.secrets.length > 0)
    if (!any && !this.deps.getSetting<boolean>(SECRET_FILES_SETTING, false)) return
    try {
      const result = await exec(secretFilesRequest(any ? bots : []))
      if (result.code !== 0) {
        this.deps.log?.('warn', 'could not write the secret files in the VM', {
          stderr: this.deps.redact(result.stderr.trim()).slice(0, 300),
        })
        return
      }
      this.deps.setSetting(SECRET_FILES_SETTING, any)
    } catch (err) {
      this.deps.log?.('warn', 'could not write the secret files in the VM', {
        err: this.deps.redact(errorMessage(err)),
      })
    }
  }
}
