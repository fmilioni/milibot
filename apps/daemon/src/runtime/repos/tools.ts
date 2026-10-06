import { laneInfo, type ToolExecContext, type ToolResult } from '@milibot/agent'
import { repoInstructionTexts } from '@milibot/agent/prompts'
import { optionalString, requireString, type ToolArgs, toolText } from '@milibot/agent/tools'
import type { Bot, LogFn } from '@milibot/shared'

import { clipMiddle, type ToolHandlers, ToolSwitch } from '../tools-core'
import { botLinuxUser, type VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { checkoutWarnings, isRepoUrl, runCheckout, sanitizeRepoName, slugPart } from './checkout'
import { readRepoInstructions } from './instructions'
import type { WorktreeStore } from './store'

/** Worktrees of the repositories in /workspace/repos, one per bot and repository. */
export interface RepoToolsDeps {
  vm: Pick<VmController, 'guest'>
  store: WorkspaceStore
  worktrees: WorktreeStore
  botEnv?: (bot: Bot) => Promise<Record<string, string>>
  log?: LogFn
}

function repoHandlers(deps: RepoToolsDeps): ToolHandlers {
  const { worktrees: worktreeStore } = deps

  async function repoCheckout(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const repo = requireString(a, 'repo')
    const name = sanitizeRepoName(repo)
    const existing = worktreeStore.active(ctx.bot.id, name)
    const branch = existing?.branch ?? `bot/${ctx.bot.slug}/${slugPart(optionalString(a, 'task'), 'work')}`
    const result = await runCheckout(guest, {
      bot: ctx.bot,
      repo,
      name,
      branch,
      baseBranch: optionalString(a, 'base_branch') ?? existing?.baseBranch ?? '',
      botEnv: (await deps.botEnv?.(ctx.bot)) ?? {},
      signal: ctx.signal,
    })
    if (result.code !== 0) {
      return toolText(
        `repo_checkout failed (exit ${result.code}):\n${clipMiddle(result.stderr || result.stdout, 4000)}`,
        true,
      )
    }
    const info = result.info
    const path = `/workspace/worktrees/${name}/${ctx.bot.slug}`
    const row =
      existing ??
      worktreeStore.insert({
        botId: ctx.bot.id,
        repoName: name,
        repoUrl: isRepoUrl(repo) ? repo : null,
        worktreePath: path,
        branch: info.BRANCH || branch,
        baseBranch: info.BASE || null,
      })
    // A session working in the bot's chat worktree keeps it from being cleaned up until the session ends.
    const sessionId = ctx.laneKey ? laneInfo(ctx.laneKey).sessionId : null
    if (sessionId) worktreeStore.usedBySession(row.id, sessionId)
    const base = info.BASE ?? row.baseBranch ?? '?'
    const reply = toolText(
      [
        `Worktree ready (${info.STATUS ?? 'ok'}): ${row.worktreePath}\nbranch: ${info.BRANCH || row.branch}\nbase: ${base}\nWork only inside this path.`,
        ...checkoutWarnings(info, base),
      ].join('\n'),
    )
    // The repository's own instructions, whatever engine the bot runs on (each file its own part).
    const files = await readRepoInstructions(guest, ctx.bot, [row.worktreePath], ctx.signal).catch(
      (err: unknown) => {
        deps.log?.('warn', 'repository instructions unavailable', { err: (err as Error).message })
        return []
      },
    )
    reply.content.push(...repoInstructionTexts(files).map((text) => ({ type: 'text' as const, text })))
    return reply
  }

  async function repoList(ctx: ToolExecContext): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const listing = await guest.exec({
      user: botLinuxUser(ctx.bot.slug),
      cmd: 'ls -1 /workspace/repos 2>/dev/null || true',
      timeoutMs: 15_000,
    })
    const bots = new Map(deps.store.bots.list().map((b) => [b.id, b.name]))
    const worktrees = worktreeStore
      .listActive()
      .map((w) => `- ${w.repoName}: ${bots.get(w.botId) ?? w.botId} → ${w.worktreePath} (${w.branch})`)
    const repos = listing.stdout.trim().split('\n').filter(Boolean)
    return toolText(
      `Repositories in /workspace/repos: ${repos.length ? repos.join(', ') : 'none'}\nActive worktrees:\n${worktrees.join('\n') || '- none'}`,
    )
  }

  async function repoRelease(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const guest = await deps.vm.guest()
    const name = sanitizeRepoName(requireString(a, 'repo'))
    const row = worktreeStore.active(ctx.bot.id, name)
    if (!row) return toolText(`You have no active worktree of ${name}.`, true)
    const result = await guest.exec({
      user: botLinuxUser(ctx.bot.slug),
      cmd: `cd /workspace/repos/"$REPO_NAME" && git worktree remove ${a.force === true ? '--force ' : ''}"$WT" && git worktree prune`,
      env: { REPO_NAME: name, WT: row.worktreePath },
      timeoutMs: 60_000,
    })
    if (result.code !== 0) {
      return toolText(
        `Could not remove the worktree:\n${clipMiddle(result.stderr || result.stdout, 3000)}\nCommit/push first or pass force.`,
        true,
      )
    }
    worktreeStore.release(row.id)
    return toolText(`Removed ${row.worktreePath} (branch ${row.branch} is kept in the repository).`)
  }

  return { repo_checkout: repoCheckout, repo_list: repoList, repo_release: repoRelease }
}

export class RepoTools extends ToolSwitch {
  readonly name = 'repos'
  protected readonly handlers: ToolHandlers

  constructor(deps: RepoToolsDeps) {
    super()
    this.handlers = repoHandlers(deps)
  }
}
