import { ToolInputError } from '@milibot/agent/tools'
import { type Bot, slugify } from '@milibot/shared'

import { type GuestClient, parseKeyValueLines } from '../vm'
import { CHECKOUT_SCRIPT } from './scripts/checkout.generated'

export function sanitizeRepoName(value: string): string {
  const base = value
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .pop()
    ?.replace(/\.git$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
  if (!base) throw new ToolInputError('could not derive a repository name')
  return base.slice(0, 64)
}

/** A branch name part ("Fix login bug" → "fix-login-bug"), cut at 40 characters. */
export function slugPart(value: string | undefined, fallback: string): string {
  return slugify(value ?? '').slice(0, 40) || fallback
}

/** A clone URL (a bare name refers to a repository already in /workspace/repos). */
export function isRepoUrl(repo: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(repo) || repo.includes('@')
}

/** What the bot must know about how current its worktree is (from the checkout script's output). */
export function checkoutWarnings(info: Record<string, string | undefined>, base: string): string[] {
  const warnings: string[] = []
  if (info.FETCH === 'failed')
    warnings.push(
      'Warning: fetching origin failed, so the code may be out of date: run `git pull` before relying on it.',
    )
  const behind = Number(info.BEHIND ?? 0)
  if (behind > 0)
    warnings.push(
      `Your branch is ${behind} commit(s) behind origin/${base}${info.DIRTY ? ' and has uncommitted changes' : ''}: ` +
        `bring it up to date (commit, then \`git rebase origin/${base}\` or \`git merge origin/${base}\`) before changing code.`,
    )
  return warnings
}

export interface CheckoutInput {
  bot: Pick<Bot, 'name' | 'slug'>
  /** URL or name of a repository already cloned. */
  repo: string
  /** `sanitizeRepoName(repo)`. */
  name: string
  branch: string
  /** '' = origin's default branch. */
  baseBranch: string
  /** Default `/workspace/worktrees/<name>/<bot slug>`. */
  worktreePath?: string
  /** The bot's environment (git identity, tokens). */
  botEnv: Record<string, string>
  signal?: AbortSignal
}

export interface CheckoutResult {
  code: number | null
  stdout: string
  stderr: string
  /** The script's `KEY=VALUE` lines. */
  info: Record<string, string>
}

/** Runs `CHECKOUT_SCRIPT` as the bot. */
export async function runCheckout(guest: GuestClient, input: CheckoutInput): Promise<CheckoutResult> {
  const { bot, botEnv } = input
  const result = await guest.exec(
    {
      user: `bot-${bot.slug}`,
      cmd: CHECKOUT_SCRIPT,
      cwd: '/workspace',
      timeoutMs: 600_000,
      env: {
        ...botEnv,
        GIT_NAME: botEnv.GIT_AUTHOR_NAME ?? `${bot.name} (Milibot)`,
        GIT_EMAIL: botEnv.GIT_AUTHOR_EMAIL ?? `${bot.slug}@milibot.local`,
        REPO_URL: isRepoUrl(input.repo) ? input.repo : '',
        REPO_NAME: input.name,
        BOT_SLUG: bot.slug,
        BOT_NAME: bot.name,
        BRANCH: input.branch,
        BASE_BRANCH: input.baseBranch,
        ...(input.worktreePath ? { WT_PATH: input.worktreePath } : {}),
        GIT_TERMINAL_PROMPT: '0',
      },
    },
    input.signal,
  )
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    info: parseKeyValueLines(result.stdout),
  }
}
