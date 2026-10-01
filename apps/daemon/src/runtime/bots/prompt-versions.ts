import type { NewAgentMessage } from '@milibot/agent'
import {
  type AuthorType,
  type Bot,
  lineDiff,
  type Message,
  PREFERENCE_SETTING_KEYS,
  type PromptUpdatedPayload,
  PromptUpdateMode,
  type PromptVersion,
  type promptVersionEndpoints,
  type WorkspaceEvent,
} from '@milibot/shared'

import { DaemonError, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { GroupService } from '../groups'
import type { WorkspaceStore } from '../workspace-store'
import { personaSizeError } from './persona-edit'
import { type NewVersion, PromptVersionStore, toVersion, type VersionRow } from './prompt-version-store'

/** Changes a bot may make to one prompt per day without the user asking for them. */
const MAX_BOT_PROMPT_UPDATES_PER_DAY = 3
const DAY_MS = 24 * 60 * 60 * 1000

/** `generateBotPrompt` drafts a persona with a model (`BotPromptRoutes`). */
type PromptVersionEndpoint = Exclude<keyof typeof promptVersionEndpoints, 'generateBotPrompt'>

/** A bot asked for a prompt change that is not allowed (too long, too frequent…); shown to the model. */
export class PromptChangeRefused extends Error {}

export interface PromptChangeRequest {
  /** Bot that asked for the change (the target itself for `update_own_prompt`). */
  author: Bot
  target: Bot
  /** New editable persona of the target. */
  text: string
  reason: string
  conversationId: string | null
  turnId: string | null
  /** The user explicitly asked for it: the daily and per-turn limits do not apply. */
  userRequested: boolean
}

export interface PromptVersionServiceDeps {
  store: WorkspaceStore
  groups: Pick<
    GroupService,
    'onConfirmed' | 'requestConfirmation' | 'cardConversation' | 'promptProposalTurns'
  >
  emit: (event: WorkspaceEvent) => void
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { payload: PromptUpdatedPayload }) => Message
  getMessage: (id: string) => Message
  now: () => number
}

/**
 * Versions of each bot's persona and the pipeline every change goes through: `update_own_prompt`,
 * a team manager's `update_bot`, edits in bot settings, undo and restore.
 */
export class PromptVersionService {
  private readonly versions: PromptVersionStore

  constructor(private readonly deps: PromptVersionServiceDeps) {
    this.versions = new PromptVersionStore(deps.store.db)
    deps.groups.onConfirmed('update_prompt', ({ requesterId, params, data }) => {
      const target = this.bot(params.botId)
      if (target.systemPrompt.trim() !== data.baseText || typeof data.text !== 'string')
        throw new DaemonError('conflict', 'The prompt changed since this was proposed')
      this.apply({
        target,
        text: data.text,
        authorType: 'bot',
        authorBotId: requesterId,
        reason: typeof data.reason === 'string' ? data.reason : null,
        turnId: typeof data.turnId === 'string' ? data.turnId : null,
      })
    })
  }

  private bot(id: string): Bot {
    return this.deps.store.bots.get(id)
  }

  mode(): PromptUpdateMode {
    const parsed = PromptUpdateMode.safeParse(
      this.deps.store.settings.get<unknown>(PREFERENCE_SETTING_KEYS.promptUpdates, 'auto'),
    )
    return parsed.success ? parsed.data : 'auto'
  }

  /** The persona a bot had before its first versioned change becomes its first version. */
  private ensureBaseline(bot: Bot): void {
    if (this.versions.hasAny(bot.id)) return
    this.insert({
      botId: bot.id,
      text: bot.systemPrompt.trim(),
      authorType: 'system',
      authorBotId: null,
      reason: null,
      before: null,
      turnId: null,
      createdAt: bot.createdAt,
    })
  }

  private insert(input: Omit<NewVersion, 'createdAt'> & { createdAt?: number }): VersionRow {
    return this.versions.insert({ ...input, createdAt: input.createdAt ?? this.deps.now() })
  }

  list(botId: string): PromptVersion[] {
    const bot = this.bot(botId)
    this.ensureBaseline(bot)
    const current = bot.systemPrompt.trim()
    const rows = this.versions.rows(botId)
    const currentId = rows.find((r) => r.text === current)?.id
    return rows.map((r) => toVersion(r, r.id === currentId))
  }

  /** Writes the new persona and records it as a version. */
  private apply(input: {
    target: Bot
    text: string
    authorType: AuthorType
    authorBotId: string | null
    reason: string | null
    turnId: string | null
  }): VersionRow {
    this.ensureBaseline(input.target)
    const version = this.insert({
      botId: input.target.id,
      text: input.text,
      authorType: input.authorType,
      authorBotId: input.authorBotId,
      reason: input.reason,
      before: input.target.systemPrompt.trim(),
      turnId: input.turnId,
    })
    const bot = this.deps.store.bots.update(input.target.id, { systemPrompt: input.text })
    this.deps.emit({ type: 'bot.updated', payload: { bot } })
    return version
  }

  /** Bot settings: the user saved a new system prompt (`update` does the write). */
  trackUserEdit(botId: string, update: () => Bot): Bot {
    const before = this.bot(botId)
    this.ensureBaseline(before)
    const bot = update()
    const text = bot.systemPrompt.trim()
    if (text !== before.systemPrompt.trim()) {
      this.insert({
        botId,
        text,
        authorType: 'user',
        authorBotId: null,
        reason: null,
        before: before.systemPrompt.trim(),
        turnId: null,
      })
    }
    return bot
  }

  private recentBotChanges(request: PromptChangeRequest): { turn: number; day: number } {
    const since = this.deps.now() - DAY_MS
    const turns = [
      ...this.versions.botChangeTurns(request.target.id, request.author.id, since),
      ...this.deps.groups.promptProposalTurns(request.author.id, request.target.id, since),
    ]
    return {
      turn: request.turnId ? turns.filter((t) => t === request.turnId).length : 0,
      day: turns.length,
    }
  }

  /**
   * A bot's change to a persona (its own or, for a team manager, another bot's). Applied right away with a
   * chat card, or proposed on a confirmation card in approval mode. Returns the message for the model;
   * throws PromptChangeRefused when the change is not allowed.
   */
  requestChange(request: PromptChangeRequest): string {
    const { author, target } = request
    const own = author.id === target.id
    const text = request.text.trim()
    const sizeError = personaSizeError(text)
    if (sizeError) throw new PromptChangeRefused(sizeError)
    const current = target.systemPrompt.trim()
    if (text === current) return 'No change: the role section already says exactly that.'
    if (!request.userRequested) {
      const recent = this.recentBotChanges(request)
      if (recent.turn >= 1)
        throw new PromptChangeRefused(
          'Not applied: you already changed this prompt in this turn. Put everything in one update (send the ' +
            'complete "new_persona"), or wait for the user.',
        )
      if (recent.day >= MAX_BOT_PROMPT_UPDATES_PER_DAY)
        throw new PromptChangeRefused(
          `Not applied: this prompt was already changed ${recent.day} times in the last 24 hours without the ` +
            'user asking. Change it again only when the user explicitly asks (then set user_requested: true); ' +
            'keep facts and preferences in memory.',
        )
    }
    const reason = request.reason.trim().slice(0, 300)
    const subject = own ? 'your role section' : `the prompt of ${target.name}`
    if (this.mode() === 'approval') {
      const diff = lineDiff(current, text)
      this.deps.groups.requestConfirmation({
        bot: author,
        conversationId: request.conversationId,
        action: 'update_prompt',
        params: {
          botId: target.id,
          botName: target.name,
          diff: diff.diff,
          added: String(diff.added),
          removed: String(diff.removed),
        },
        reason,
        data: { text, baseText: current, reason, turnId: request.turnId },
      })
      return (
        `Proposed the change to ${subject}; it waits for the user's approval (a card in the chat) and applies ` +
        'only if they approve. You do not need to follow up.'
      )
    }
    const version = this.apply({
      target,
      text,
      authorType: 'bot',
      authorBotId: author.id,
      reason,
      turnId: request.turnId,
    })
    const card = this.deps.appendMessage({
      conversationId: this.deps.groups.cardConversation(author, request.conversationId),
      authorType: 'bot',
      authorBotId: author.id,
      kind: 'card',
      content: own
        ? `${author.name} updated its own prompt: ${reason}`
        : `${author.name} updated the prompt of ${target.name}: ${reason}`,
      payload: {
        type: 'prompt_updated',
        versionId: version.id,
        botId: target.id,
        authorBotId: author.id,
        reason,
        diff: version.diff,
        added: version.added,
        removed: version.removed,
      },
    })
    this.versions.setMessage(version.id, card.id)
    return (
      `Updated ${subject}; it takes effect from ${own ? 'your' : 'its'} next turn. The user sees the change in ` +
      'the chat and can undo it.'
    )
  }

  /** Makes `versionId`'s text the bot's persona again, as a new version by the user. */
  restore(botId: string, versionId: string): PromptVersion {
    const row = this.versions.row(versionId)
    if (row.bot_id !== botId) throw notFound('prompt version', versionId)
    const target = this.bot(botId)
    if (target.systemPrompt.trim() === row.text)
      return this.list(botId).find((v) => v.id === versionId) as PromptVersion
    const version = this.apply({
      target,
      text: row.text,
      authorType: 'user',
      authorBotId: null,
      reason: null,
      turnId: null,
    })
    return toVersion(version, true)
  }

  /** "Undo" on a chat card: restores the version before `versionId` and marks the card undone. */
  undo(versionId: string): PromptVersion {
    const row = this.versions.row(versionId)
    const previous = this.versions.previous(row)
    if (!previous) throw new DaemonError('conflict', 'There is no earlier version to go back to')
    const target = this.bot(row.bot_id)
    const current = target.systemPrompt.trim()
    if (current !== row.text && current !== previous.text)
      throw new DaemonError(
        'conflict',
        'The prompt changed after this version; restore a version in the bot settings instead',
        { reason: 'PROMPT_CHANGED' },
      )
    const version =
      current === previous.text
        ? previous
        : this.apply({
            target,
            text: previous.text,
            authorType: 'user',
            authorBotId: null,
            reason: null,
            turnId: null,
          })
    if (row.message_id) {
      try {
        const card = this.deps.getMessage(row.message_id)
        if (card.payload?.type === 'prompt_updated')
          this.deps.updateMessage(card.id, { payload: { ...card.payload, undone: true } })
      } catch {
        // The card was deleted with its conversation; the prompt is restored anyway.
      }
    }
    return toVersion(version, true)
  }

  handlers(): EndpointHandlers<PromptVersionEndpoint> {
    return {
      listPromptVersions: ({ params }) => this.list(params.botId),
      restorePromptVersion: ({ params }) => this.restore(params.botId, params.versionId),
      undoPromptVersion: ({ params }) => this.undo(params.versionId),
    }
  }
}
