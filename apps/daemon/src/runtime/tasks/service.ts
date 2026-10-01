import type { NewAgentMessage, ToolCallFinish, ToolCallStart } from '@milibot/agent'
import { ANTIGRAVITY_TOOLS, CODEX_TOOLS } from '@milibot/agent/cli'
import {
  type Bot,
  type ExecResult,
  type LogFn,
  type Message,
  type MessagePayload,
  TaskPayload,
  type TaskStatus,
} from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { MessageStore } from '../messages'
import {
  detectPrCommand,
  type GhPrView,
  parseGhPrView,
  type PrCommand,
  statusAfter,
  statusOfPr,
} from './pr-detect'

export type TaskCard = Omit<TaskPayload, 'type'>

/** Shell tools whose commands are checked for `gh pr …` (the bash tool and the CLI engines' shells). */
const SHELL_TOOLS = new Set<string>(['bash', 'Bash', CODEX_TOOLS.exec, ANTIGRAVITY_TOOLS.command])

export const STATUS_WORDS: Record<TaskStatus, string> = {
  open: 'open',
  review: 'in review',
  done: 'done',
  failed: 'failed',
}

export interface TaskCardServiceDeps {
  messages: Pick<MessageStore, 'latestCard'>
  getBot(id: string): Bot | null
  directConversationId(botId: string): string | null
  appendMessage(message: NewAgentMessage): Message
  updateMessage(id: string, patch: { content?: string; payload?: MessagePayload | null }): Message
  /** Runs a command in the VM as the bot's Linux user; null when the VM is not running. */
  exec(bot: Bot, cmd: string, env: Record<string, string>): Promise<ExecResult | null>
  /** A pull request card was posted or changed in a conversation. */
  onPullRequest?(conversationId: string, payload: TaskPayload): void
  log?: LogFn
}

/**
 * Task/PR cards: `report_task`, and pull requests the bots open or merge with `gh pr …` in a shell
 * (detected from the command and its output, then refreshed with `gh pr view`). A card with the same
 * url (or repo + number) is updated in place wherever it was posted.
 */
export class TaskCardService {
  private readonly shellCalls = new Map<
    string,
    { botId: string; conversationId: string | null; turnId: string | null; command: string }
  >()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly deps: TaskCardServiceDeps) {}

  /** `report_task`: posts or updates the bot's card; null when there is no conversation to post it in. */
  report(
    bot: Bot,
    conversationId: string | null,
    turnId: string | null,
    card: TaskCard,
  ): { updated: boolean } | null {
    const target = conversationId ?? this.deps.directConversationId(bot.id)
    if (!target) return null
    return { updated: this.upsert(target, bot, card, turnId).updated }
  }

  onToolStarted(record: ToolCallStart): void {
    if (record.toolName === 'repo_release') {
      this.shellCalls.set(record.id, {
        botId: record.botId,
        conversationId: record.conversationId,
        turnId: record.turnId,
        command: '',
      })
      return
    }
    if (!SHELL_TOOLS.has(record.toolName)) return
    const command = (record.arguments as { command?: unknown } | null)?.command
    if (typeof command !== 'string' || !/\bgh\s+pr\s/.test(command)) return
    this.shellCalls.set(record.id, {
      botId: record.botId,
      conversationId: record.conversationId,
      turnId: record.turnId,
      command,
    })
  }

  onToolFinished(id: string, finish: ToolCallFinish): void {
    const call = this.shellCalls.get(id)
    if (!call) return
    this.shellCalls.delete(id)
    if (finish.status === 'cancelled') return
    const output = resultText(finish.result)
    if (!call.command) {
      if (finish.status === 'ok') this.track(this.fromRelease(call, output))
      return
    }
    const detected = detectPrCommand(call.command, output, finish.status === 'error')
    if (!detected) return
    this.track(this.fromCommand(call, detected))
  }

  private track(work: Promise<void>): void {
    const task = work.catch((err: unknown) =>
      this.deps.log?.('warn', 'pull request card failed', { err: errorMessage(err) }),
    )
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  /** `repo_release` of a worktree whose branch has a pull request: the card shows where it stands. */
  private async fromRelease(
    call: { botId: string; conversationId: string | null; turnId: string | null },
    output: string,
  ): Promise<void> {
    const match = /Removed \/workspace\/worktrees\/([^/\s]+)\/\S+ \(branch (\S+) is kept/.exec(output)
    const bot = this.deps.getBot(call.botId)
    if (!match || !bot) return
    const view = await this.viewPr(bot, match[2] as string, `/workspace/repos/${match[1]}`)
    if (!view) return
    const conversationId = call.conversationId ?? this.deps.directConversationId(bot.id)
    if (!conversationId) return
    this.upsert(
      conversationId,
      bot,
      {
        title: view.title || `Pull request #${view.number}`,
        status: statusOfPr(view),
        url: view.url,
        repo: repoOf(view.url),
        prNumber: view.number,
        branch: view.headRefName || (match[2] as string),
        botId: bot.id,
      },
      call.turnId,
    )
  }

  /** Resolves when the cards of commands already finished are posted (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  private async fromCommand(
    call: { botId: string; conversationId: string | null; turnId: string | null },
    command: PrCommand,
  ): Promise<void> {
    const bot = this.deps.getBot(call.botId)
    if (!bot) return
    const existing = command.url
      ? this.findCard({ url: command.url })
      : command.number !== null
        ? this.findCard({ repo: command.repo, prNumber: command.number, botId: bot.id })
        : null
    const url = command.url ?? existing?.payload.url ?? null
    const view = url ? await this.viewPr(bot, url) : null
    const status = view
      ? command.auto && view.state === 'OPEN'
        ? 'review'
        : statusOfPr(view)
      : statusAfter(command)
    const prNumber = view?.number ?? command.number ?? existing?.payload.prNumber ?? null
    const card: TaskCard = {
      title:
        view?.title ||
        command.title ||
        existing?.payload.title ||
        (prNumber !== null ? `Pull request #${prNumber}` : 'Pull request'),
      status,
      url: view?.url ?? url,
      repo: command.repo ?? existing?.payload.repo ?? repoOf(url),
      prNumber,
      branch: view?.headRefName || command.branch || existing?.payload.branch || null,
      botId: bot.id,
    }
    const conversationId = call.conversationId ?? this.deps.directConversationId(bot.id)
    if (!conversationId) return
    this.upsert(conversationId, bot, card, call.turnId, existing)
  }

  /** `gh pr view` as the bot (its gh login); `target` is a URL, or a branch read in `cwd`. */
  private async viewPr(bot: Bot, target: string, cwd?: string): Promise<GhPrView | null> {
    try {
      const result = await this.deps.exec(
        bot,
        `${cwd ? 'cd "$PR_CWD" && ' : ''}gh pr view "$PR_TARGET" --json number,title,url,state,isDraft,headRefName`,
        { PR_TARGET: target, ...(cwd ? { PR_CWD: cwd } : {}) },
      )
      return result && result.code === 0 ? parseGhPrView(result.stdout) : null
    } catch {
      return null
    }
  }

  /** The newest card for this PR (by url, else repo + number, else the bot's own card with that number). */
  findCard(key: {
    url?: string | null
    repo?: string | null
    prNumber?: number | null
    botId?: string
  }): { id: string; payload: TaskPayload } | null {
    const found = key.url
      ? this.deps.messages.latestCard('task', { url: key.url })
      : key.prNumber !== null && key.prNumber !== undefined && (key.repo || key.botId)
        ? this.deps.messages.latestCard(
            'task',
            key.repo
              ? { prNumber: key.prNumber, repo: key.repo }
              : { prNumber: key.prNumber, botId: key.botId as string },
          )
        : null
    const parsed = found ? TaskPayload.safeParse(found.payload) : null
    return found && parsed?.success ? { id: found.id, payload: parsed.data } : null
  }

  upsert(
    conversationId: string,
    bot: Bot,
    card: TaskCard,
    turnId: string | null,
    known?: { id: string; payload: TaskPayload } | null,
  ): { message: Message; updated: boolean } {
    const existing =
      known ??
      (card.url
        ? this.findCard({ url: card.url })
        : card.repo && card.prNumber !== null
          ? this.findCard({ repo: card.repo, prNumber: card.prNumber })
          : null)
    const payload: TaskPayload = { type: 'task', ...card }
    const content = `${card.title} — ${STATUS_WORDS[card.status]}${card.url ? ` (${card.url})` : ''}`
    if (existing) {
      const merged: TaskPayload = {
        ...payload,
        repo: card.repo ?? existing.payload.repo,
        prNumber: card.prNumber ?? existing.payload.prNumber,
        branch: card.branch ?? existing.payload.branch,
        url: card.url ?? existing.payload.url,
      }
      const message = this.deps.updateMessage(existing.id, { content, payload: merged })
      this.pullRequestChanged(conversationId, merged)
      return { message, updated: true }
    }
    const message = this.deps.appendMessage({
      conversationId,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'card',
      content,
      payload,
      turnId,
    })
    this.pullRequestChanged(conversationId, payload)
    return { message, updated: false }
  }

  private pullRequestChanged(conversationId: string, payload: TaskPayload): void {
    if (payload.prNumber === null && !payload.url?.includes('/pull/')) return
    try {
      this.deps.onPullRequest?.(conversationId, payload)
    } catch (err) {
      this.deps.log?.('warn', 'pull request link failed', { err: errorMessage(err) })
    }
  }
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  const text = (result as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text : ''
}

function repoOf(url: string | null): string | null {
  return url ? (/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url)?.[1] ?? null) : null
}
