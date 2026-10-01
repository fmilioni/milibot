import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  flagArg,
  optionalString,
  requireString,
  stringListArg,
  type ToolArgs,
  ToolInputError,
  toolText,
} from '@milibot/agent/tools'
import { Avatar, type Bot } from '@milibot/shared'

import { DaemonError } from '../../errors'
import type { GroupService } from '../groups'
import { ToolSwitch } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { applyPersonaEdit, parsePersonaEdit, personaSizeError } from './persona-edit'
import { PromptChangeRefused, type PromptVersionService } from './prompt-versions'

function parseAvatar(value: unknown): Avatar | undefined {
  if (!value || typeof value !== 'object') return undefined
  const parsed = Avatar.partial().safeParse(value)
  if (!parsed.success) return undefined
  const { shape, color, eyes } = parsed.data
  return shape && color && eyes ? { shape, color, eyes } : undefined
}

/** A string argument when given, even empty (clears the field); undefined otherwise. */
function givenString(a: ToolArgs, key: string): string | undefined {
  const value = a[key]
  return typeof value === 'string' ? value : undefined
}

function botList(a: ToolArgs, key: string): string[] {
  const list = stringListArg(a, key, { split: ',' })
  if (list.length === 0) throw new ToolInputError(`"${key}" must list at least one bot`)
  return list
}

export interface NewBotInput {
  name: string
  label: string
  systemPrompt: string
  model: string | null
  avatar?: Avatar
}

export interface TeamToolsDeps {
  store: WorkspaceStore
  groups: Pick<
    GroupService,
    | 'managesTeam'
    | 'createGroup'
    | 'findGroup'
    | 'assertBotCanManage'
    | 'addMember'
    | 'removeMember'
    | 'needsConfirmation'
    | 'requestConfirmation'
    | 'deleteBot'
  >
  /** Versioned persona changes (`update_own_prompt`, `update_bot` with a system prompt). */
  prompts: Pick<PromptVersionService, 'requestChange'>
  createBot(input: NewBotInput, creator: Bot): Promise<Bot>
  updateBot(id: string, patch: Partial<NewBotInput>): Bot
}

/** The team tools: bots, their personas and groups. */
export class TeamTools extends ToolSwitch {
  readonly name = 'team'
  protected readonly handlers = {
    list_bots: () => this.listBots(),
    create_bot: (ctx: ToolExecContext, a: ToolArgs) => this.createBot(ctx, a),
    update_bot: (ctx: ToolExecContext, a: ToolArgs) => this.updateBot(ctx, a),
    update_own_prompt: (ctx: ToolExecContext, a: ToolArgs) => this.updateOwnPrompt(ctx, a),
    create_group: (ctx: ToolExecContext, a: ToolArgs) => this.createGroup(ctx, a),
    add_member: (ctx: ToolExecContext, a: ToolArgs) => this.addMember(ctx, a),
    remove_member: (ctx: ToolExecContext, a: ToolArgs) => this.removeMember(ctx, a),
    delete_bot: (ctx: ToolExecContext, a: ToolArgs) => this.deleteBot(ctx, a),
  }

  constructor(private readonly deps: TeamToolsDeps) {
    super()
  }

  private botByRef(ref: string): Bot {
    const bot = this.deps.store.bots.resolveRef(ref)
    if (!bot) throw new DaemonError('not_found', `There is no bot named "${ref}" (use list_bots).`)
    return bot
  }

  private listBots(): ToolResult {
    const lines = this.deps.store.bots.list().map((b) => {
      const role = b.systemPrompt.replace(/\s+/g, ' ').slice(0, 160)
      const manager = this.deps.groups.managesTeam(b) ? ', manages the team' : ''
      return `- ${b.name} (id ${b.id}, label "${b.label}"${manager}, status ${b.status}${b.model ? `, model ${b.model}` : ''})${role ? `: ${role}` : ''}`
    })
    return toolText(lines.join('\n') || 'No bots.')
  }

  private async createBot(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const systemPrompt = requireString(a, 'system_prompt').trim()
    const sizeError = personaSizeError(systemPrompt)
    if (sizeError)
      return toolText(
        sizeError.replace('Not applied: the new role section', 'Not created: the system prompt'),
        true,
      )
    const avatar = parseAvatar(a.avatar)
    const bot = await this.deps.createBot(
      {
        name: requireString(a, 'name').slice(0, 48),
        label: (optionalString(a, 'label') ?? '').slice(0, 32),
        systemPrompt,
        model: optionalString(a, 'model') ?? null,
        ...(avatar ? { avatar } : {}),
      },
      ctx.bot,
    )
    return toolText(
      `Created ${bot.name} (id ${bot.id}, label "${bot.label}", display :${bot.displayNum}). ` +
        'It is introducing itself to the user in its own chat now.',
    )
  }

  private changePrompt(
    ctx: ToolExecContext,
    target: Bot,
    newText: string,
    reason: string,
    userRequested: boolean,
  ): ToolResult {
    try {
      return toolText(
        this.deps.prompts.requestChange({
          author: ctx.bot,
          target,
          text: newText,
          reason,
          conversationId: ctx.conversationId,
          turnId: ctx.turnId,
          userRequested,
        }),
      )
    } catch (err) {
      if (err instanceof PromptChangeRefused) return toolText(err.message, true)
      throw err
    }
  }

  private updateBot(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const target = this.botByRef(requireString(a, 'bot'))
    const avatar = parseAvatar(a.avatar)
    const name = optionalString(a, 'name')
    const label = givenString(a, 'label')
    const model = givenString(a, 'model')
    const patch = {
      ...(name ? { name: name.slice(0, 48) } : {}),
      ...(label !== undefined ? { label: label.slice(0, 32) } : {}),
      ...(model !== undefined ? { model: model || null } : {}),
      ...(avatar ? { avatar } : {}),
    }
    const updated = Object.keys(patch).length ? this.deps.updateBot(target.id, patch) : target
    const summary = Object.keys(patch).length ? `Updated ${updated.name} (id ${updated.id}).` : ''
    const prompt = optionalString(a, 'system_prompt')
    if (!prompt) return toolText(summary || `Nothing to change for ${target.name}.`)
    const result = this.changePrompt(ctx, updated, prompt, optionalString(a, 'reason') ?? '', true)
    const message = (result.content[0] as { text: string }).text
    return toolText(summary ? `${summary} ${message}` : message, result.isError === true && !summary)
  }

  private updateOwnPrompt(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const reason = optionalString(a, 'reason')?.trim()
    if (!reason)
      throw new ToolInputError('"reason" is required: say what the user asked that motivates the change')
    const edit = parsePersonaEdit(a)
    if ('error' in edit) throw new ToolInputError(edit.error)
    const current = this.deps.store.bots.find(ctx.bot.id) ?? ctx.bot
    const applied = applyPersonaEdit(current.systemPrompt.trim(), edit)
    if ('error' in applied) return toolText(applied.error, true)
    return this.changePrompt(ctx, current, applied.text, reason, flagArg(a, 'user_requested') === true)
  }

  private createGroup(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const name = requireString(a, 'name').trim().slice(0, 64)
    const members = [...new Set(botList(a, 'members').map((ref) => this.botByRef(ref)))]
    const group = this.deps.groups.createGroup(
      { type: 'bot', bot: ctx.bot },
      { title: name, botIds: [...new Set(members.map((b) => b.id))] },
    )
    return toolText(
      `Created the group "${name}" (id ${group.id}) with the user and ${members.map((b) => b.name).join(', ')}. ` +
        "It is in the user's sidebar.",
    )
  }

  private addMember(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const { groups } = this.deps
    const group = groups.findGroup(requireString(a, 'group'), ctx.conversationId)
    groups.assertBotCanManage(ctx.bot, group)
    const bot = this.botByRef(requireString(a, 'bot'))
    const title = group.title ?? 'group'
    if (group.memberBotIds.includes(bot.id)) return toolText(`${bot.name} is already in "${title}".`)
    groups.addMember({ type: 'bot', bot: ctx.bot }, group.id, bot.id)
    return toolText(`Added ${bot.name} to "${title}".`)
  }

  private removeMember(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const { groups } = this.deps
    const group = groups.findGroup(requireString(a, 'group'), ctx.conversationId)
    groups.assertBotCanManage(ctx.bot, group)
    const bot = this.botByRef(requireString(a, 'bot'))
    const title = group.title ?? 'group'
    if (!group.memberBotIds.includes(bot.id)) return toolText(`${bot.name} is not in "${title}".`, true)
    if (group.memberBotIds.length <= 1)
      return toolText(`${bot.name} is the last bot of "${title}"; a group needs at least one.`, true)
    if (groups.needsConfirmation('remove_member', group)) {
      groups.requestConfirmation({
        bot: ctx.bot,
        conversationId: ctx.conversationId,
        action: 'remove_member',
        params: { botId: bot.id, botName: bot.name, groupId: group.id, groupName: title },
        reason: optionalString(a, 'reason')?.slice(0, 300) ?? '',
      })
      return toolText(
        `Asked the user to confirm removing ${bot.name} from "${title}" (a card in the chat). They decide there; ` +
          'you do not need to follow up.',
      )
    }
    groups.removeMember({ type: 'bot', bot: ctx.bot }, group.id, bot.id)
    return toolText(`Removed ${bot.name} from "${title}".`)
  }

  private deleteBot(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const { store, groups } = this.deps
    const bot = this.botByRef(requireString(a, 'bot'))
    if (bot.id === ctx.bot.id) return toolText('You cannot delete yourself; ask the user to do it.', true)
    if (store.bots.list().length <= 1)
      return toolText(`${bot.name} is the last bot and cannot be deleted.`, true)
    if (groups.needsConfirmation('delete_bot')) {
      groups.requestConfirmation({
        bot: ctx.bot,
        conversationId: ctx.conversationId,
        action: 'delete_bot',
        params: { botId: bot.id, botName: bot.name },
        reason: optionalString(a, 'reason')?.slice(0, 300) ?? '',
      })
      return toolText(
        `Asked the user to confirm deleting ${bot.name} (a card in the chat). They decide there; you do not need ` +
          'to follow up.',
      )
    }
    groups.deleteBot(
      { type: 'bot', bot: ctx.bot },
      bot.id,
      store.conversations.forCard(ctx.bot, ctx.conversationId),
    )
    return toolText(`Deleted ${bot.name}.`)
  }
}
