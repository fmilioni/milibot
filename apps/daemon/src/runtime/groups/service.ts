import type { NewAgentMessage } from '@milibot/agent'
import {
  type Bot,
  type ConfirmationPayload,
  type ConversationSummary,
  GROUP_SETTING_KEYS,
  type groupEndpoints,
  groupSettings,
  type Message,
  newId,
  type SystemEventName,
  type UpdateGroupSettingsBody,
  type WorkspaceEvent,
} from '@milibot/shared'
import type { z } from 'zod'

import { parseJson } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { foldKey, resolveByRef } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { type ConfirmationAction, ConfirmationStore } from './store'

export type Actor = { type: 'user' } | { type: 'bot'; bot: Bot }

export interface ConfirmationParams {
  botId: string
  botName: string
  groupId?: string
  groupName?: string
  /** More card fields (strings only), e.g. the diff of a prompt change. */
  [field: string]: string | undefined
}

/**
 * Runs an approved (or, with `onRejected`, a rejected) action registered by another service; a DaemonError
 * marks the card expired.
 */
export type ConfirmationHandler = (input: {
  confirmationId: string
  requesterId: string
  conversationId: string
  params: ConfirmationParams
  data: Record<string, unknown>
}) => void

export interface GroupServiceDeps {
  store: WorkspaceStore
  emit: (event: WorkspaceEvent) => void
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { payload: ConfirmationPayload }) => Message
  deleteBot: (botId: string) => void
  /** The bot has the team-management skill active (it manages any group). */
  managesTeam?: (bot: Bot) => boolean
  now: () => number
}

/** Groups, their members and settings, and the confirmation cards of destructive bot requests. */
export class GroupService {
  private readonly confirmationHandlers = new Map<ConfirmationAction, ConfirmationHandler>()
  private readonly rejectionHandlers = new Map<ConfirmationAction, ConfirmationHandler>()
  private readonly confirmations: ConfirmationStore

  constructor(private readonly deps: GroupServiceDeps) {
    this.confirmations = new ConfirmationStore(deps.store.db, deps.now)
  }

  onConfirmed(action: ConfirmationAction, handler: ConfirmationHandler): void {
    this.confirmationHandlers.set(action, handler)
  }

  onRejected(action: ConfirmationAction, handler: ConfirmationHandler): void {
    this.rejectionHandlers.set(action, handler)
  }

  private get store(): WorkspaceStore {
    return this.deps.store
  }

  private emitConversation(conversation: ConversationSummary, created = false): ConversationSummary {
    this.deps.emit({
      type: created ? 'conversation.created' : 'conversation.updated',
      payload: { conversation },
    })
    return conversation
  }

  private systemLine(
    conversationId: string,
    event: SystemEventName,
    botId: string | null,
    params: Record<string, string | null>,
    content: string,
  ): void {
    this.deps.appendMessage({
      conversationId,
      authorType: 'system',
      kind: 'system_event',
      content,
      payload: { type: 'system', event, botId, params },
    })
  }

  private actorParams(actor: Actor): { actor: string; actorName: string | null; actorBotId: string | null } {
    return actor.type === 'user'
      ? { actor: 'user', actorName: null, actorBotId: null }
      : { actor: 'bot', actorName: actor.bot.name, actorBotId: actor.bot.id }
  }

  private actorName(actor: Actor): string {
    return actor.type === 'user' ? 'You' : actor.bot.name
  }

  findBot(ref: string): Bot {
    const bot = this.store.bots.resolveRef(ref)
    if (!bot) throw new DaemonError('not_found', `There is no bot named "${ref}" (use list_bots).`)
    return bot
  }

  /** A group by id or title; "current" is the conversation the bot is working in. */
  findGroup(ref: string, currentConversationId: string | null): ConversationSummary {
    const key = foldKey(ref)
    if ((key === 'current' || key === 'this' || key === '') && currentConversationId) {
      const current = this.store.conversations.get(currentConversationId)
      if (current.type === 'group') return current
      throw new DaemonError('validation_failed', 'This conversation is not a group; give the group name.')
    }
    const groups = this.store.conversations.list().filter((c) => c.type === 'group')
    const match = resolveByRef(groups, ref, {
      id: (c) => c.id,
      names: (c) => [c.title ?? ''],
      partialAllowed: () => key.length >= 3,
      ambiguous: { exact: 'first', partial: 'first' },
    })
    if (!('found' in match)) throw new DaemonError('not_found', `There is no group named "${ref}".`)
    return match.found
  }

  private groupName(group: ConversationSummary): string {
    return group.title ?? 'group'
  }

  createGroup(actor: Actor, input: { title: string | null; botIds: string[] }): ConversationSummary {
    const conversation = this.store.conversations.create({
      type: 'group',
      botIds: input.botIds,
      title: input.title,
    })
    this.emitConversation(conversation, true)
    if (actor.type === 'bot') {
      this.systemLine(
        conversation.id,
        'group_created',
        actor.bot.id,
        { ...this.actorParams(actor), groupName: conversation.title },
        `${actor.bot.name} created the group`,
      )
    }
    return this.store.conversations.get(conversation.id)
  }

  managesTeam(bot: Bot): boolean {
    return this.deps.managesTeam?.(bot) ?? false
  }

  /** Bots may manage members when they manage the team, or are members of a group that allows it. */
  assertBotCanManage(bot: Bot, group: ConversationSummary): void {
    if (this.managesTeam(bot)) return
    if (!group.memberBotIds.includes(bot.id))
      throw new DaemonError('validation_failed', `You are not a member of "${this.groupName(group)}".`)
    if (!groupSettings(group).botsCanManageMembers)
      throw new DaemonError(
        'validation_failed',
        `The user does not let bots change the members of "${this.groupName(group)}".`,
      )
  }

  addMember(actor: Actor, groupId: string, botId: string): ConversationSummary {
    const bot = this.store.bots.get(botId)
    const added = this.store.conversations.addMember(groupId, botId)
    const group = this.store.conversations.get(groupId)
    if (!added) return group
    this.emitConversation(group)
    this.systemLine(
      groupId,
      'member_added',
      bot.id,
      { ...this.actorParams(actor), botName: bot.name, groupName: group.title },
      `${this.actorName(actor)} added ${bot.name} to the group`,
    )
    return this.store.conversations.get(groupId)
  }

  removeMember(actor: Actor, groupId: string, botId: string): ConversationSummary {
    const bot = this.store.bots.get(botId)
    const removed = this.store.conversations.removeMember(groupId, botId)
    const group = this.store.conversations.get(groupId)
    if (!removed) return group
    this.emitConversation(group)
    this.systemLine(
      groupId,
      'member_removed',
      bot.id,
      { ...this.actorParams(actor), botName: bot.name, groupName: group.title },
      `${this.actorName(actor)} removed ${bot.name} from the group`,
    )
    return this.store.conversations.get(groupId)
  }

  updateSettings(groupId: string, patch: z.output<typeof UpdateGroupSettingsBody>): ConversationSummary {
    return this.emitConversation(this.store.conversations.updateGroupSettings(groupId, patch))
  }

  deleteBot(actor: Actor, botId: string, lineConversationId: string): void {
    const bot = this.store.bots.get(botId)
    this.deps.deleteBot(bot.id)
    this.systemLine(
      lineConversationId,
      'bot_deleted',
      bot.id,
      { ...this.actorParams(actor), botName: bot.name },
      `${bot.name} was deleted`,
    )
  }

  /** Where a bot's confirmation card goes: its current chat, else its direct chat with the user. */
  cardConversation(bot: Bot, conversationId: string | null): string {
    return this.store.conversations.forCard(bot, conversationId)
  }

  requestConfirmation(input: {
    bot: Bot
    conversationId: string | null
    action: ConfirmationAction
    params: ConfirmationParams
    reason: string
    /** Stored with the confirmation for its handler; not shown on the card. */
    data?: Record<string, unknown>
  }): Message {
    const id = newId('confirmation')
    const conversationId = this.cardConversation(input.bot, input.conversationId)
    const title =
      input.action === 'remove_member'
        ? `${input.bot.name} wants to remove ${input.params.botName} from ${input.params.groupName ?? 'the group'}`
        : input.action === 'update_prompt'
          ? `${input.bot.name} wants to update the prompt of ${input.params.botName}`
          : input.action === 'continue_bot_exchange'
            ? `${input.bot.name} and ${input.params.botName} have been going back and forth without you`
            : input.action === 'mcp_add'
              ? `${input.bot.name} wants to add the MCP server ${input.params.serverName}`
              : input.action === 'mcp_update'
                ? `${input.bot.name} wants to change the MCP server ${input.params.serverName}`
                : input.action === 'mcp_remove'
                  ? `${input.bot.name} wants to remove the MCP server ${input.params.serverName}`
                  : `${input.bot.name} wants to delete ${input.params.botName}`
    const payload: ConfirmationPayload = {
      type: 'confirmation',
      confirmationId: id,
      action: input.action,
      description: input.reason,
      status: 'pending',
      params: Object.fromEntries(
        Object.entries(input.params).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
    }
    this.confirmations.insert({
      id,
      botId: input.bot.id,
      conversationId,
      action: input.action,
      params: JSON.stringify({ ...input.params, ...(input.data ? { data: input.data } : {}) }),
    })
    const message = this.deps.appendMessage({
      conversationId,
      authorType: 'bot',
      authorBotId: input.bot.id,
      kind: 'card',
      content: input.reason ? `${title}: ${input.reason}` : title,
      payload,
    })
    this.confirmations.setMessage(id, message.id)
    return message
  }

  /** Turn ids of `authorId`'s prompt proposals for `targetId` since `since` that were not approved. */
  promptProposalTurns(authorId: string, targetId: string, since: number): Array<string | null> {
    return this.confirmations.promptProposalParams(authorId, targetId, since).map((params) => {
      const turnId = parseJson<{ data?: { turnId?: unknown } } | null>(params, null)?.data?.turnId
      return typeof turnId === 'string' ? turnId : null
    })
  }

  resolveConfirmation(id: string, approved: boolean): Message {
    const row = this.confirmations.find(id)
    if (!row?.message_id) throw notFound('confirmation', id)
    const card = this.deps.store.messages.get(row.message_id)
    if (row.status !== 'pending') return card
    const { data, ...params } = parseJson<ConfirmationParams & { data?: Record<string, unknown> }>(
      row.params,
      {
        botId: '',
        botName: '',
      },
    )
    let status: ConfirmationPayload['status'] = approved ? 'approved' : 'rejected'
    const handlerInput = {
      confirmationId: row.id,
      requesterId: row.bot_id,
      conversationId: row.conversation_id,
      params: params as ConfirmationParams,
      data: data ?? {},
    }
    if (!approved) this.rejectionHandlers.get(row.action)?.(handlerInput)
    if (approved) {
      try {
        const requester = this.store.bots.find(row.bot_id)
        const actor: Actor = requester ? { type: 'bot', bot: requester } : { type: 'user' }
        if (row.action === 'remove_member' && params.groupId) {
          this.removeMember(actor, params.groupId, params.botId)
        } else if (row.action === 'delete_bot') {
          this.deleteBot(actor, params.botId, row.conversation_id)
        } else {
          this.confirmationHandlers.get(row.action)?.(handlerInput)
        }
      } catch (err) {
        if (!(err instanceof DaemonError)) throw err
        status = 'expired'
      }
    }
    this.confirmations.setStatus(id, status)
    const payload = card.payload?.type === 'confirmation' ? card.payload : null
    if (!payload) return card
    return this.deps.updateMessage(card.id, { payload: { ...payload, status } })
  }

  /** Whether a bot's request of `action` needs the user's confirmation first. */
  needsConfirmation(action: ConfirmationAction, group?: ConversationSummary): boolean {
    if (action === 'remove_member') return group ? groupSettings(group).confirmRemovals : true
    return this.store.settings.get<boolean>(GROUP_SETTING_KEYS.confirmBotDeletion, true) !== false
  }

  handlers(): EndpointHandlers<keyof typeof groupEndpoints | 'resolveConfirmation'> {
    const user: Actor = { type: 'user' }
    return {
      updateGroupSettings: ({ params, body }) => this.updateSettings(params.conversationId, body),
      addGroupMember: ({ params, body }) => this.addMember(user, params.conversationId, body.botId),
      removeGroupMember: ({ params }) => this.removeMember(user, params.conversationId, params.botId),
      resolveConfirmation: ({ params, body }) =>
        this.resolveConfirmation(params.confirmationId, body.approved),
    }
  }
}
