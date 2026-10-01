import type { AgentHost } from '@milibot/agent'
import type {
  Bot,
  botControlEndpoints,
  botEndpoints,
  ConversationSummary,
  LogFn,
  ModelChoice,
  WorkspaceEvent,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { SETUP_PENDING_KEY } from '../../workspace-db/setup-keys'
import type { MessageWriter } from '../messages'
import type { ToolCallStore } from '../observability'
import type { VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import type { PromptVersionService } from './prompt-versions'
import type { NewBot } from './store'
import type { NewBotInput } from './tools'

type BotEndpoint = keyof typeof botEndpoints | keyof typeof botControlEndpoints

export interface BotServiceDeps {
  store: WorkspaceStore
  emit: (event: WorkspaceEvent) => void
  vm: Pick<VmController, 'provisionBot' | 'removeBot' | 'vncPort'>
  host: Pick<AgentHost, 'enqueueTurn' | 'forgetBot' | 'screenState' | 'control'>
  messages: Pick<MessageWriter, 'append' | 'conversationUpdated'>
  prompts: Pick<PromptVersionService, 'trackUserEdit'>
  toolCalls: Pick<ToolCallStore, 'botActivity'>
  /** Provider + model for a bot created without one (`newBotModel` preference). */
  newBotModel: () => ModelChoice | null
  /** The bot's desktop exists: its credentials and secret files go to the VM. */
  provisioned: (bot: Bot) => void
  /** Drops the deleted bot's credentials (secret files, git identity). */
  forgetCredentials: (botId: string) => Promise<void>
  log: LogFn
}

/**
 * Bots from creation to deletion, by the user (routes) or by a bot (team tools): the events the app shows,
 * the bot's desktop in the VM and its introduction. Services holding a bot's work stop it while it is still
 * there (`onDeleting`) or drop what is left once it is gone (`onDeleted`).
 */
export class BotService {
  private readonly deleting: Array<(botId: string) => void> = []
  private readonly deleted: Array<(botId: string) => void> = []

  constructor(private readonly deps: BotServiceDeps) {}

  onDeleting(listener: (botId: string) => void): void {
    this.deleting.push(listener)
  }

  onDeleted(listener: (botId: string) => void): void {
    this.deleted.push(listener)
  }

  /** A bot the user creates; without a provider or model it gets `newBotModel`. */
  create(input: NewBot): { bot: Bot; conversation: ConversationSummary } {
    const preset =
      input.providerId === undefined && input.model === undefined ? this.deps.newBotModel() : null
    const bot = this.deps.store.bots.create(preset ? { ...input, ...preset } : input)
    const conversation = this.deps.store.conversations.create({ type: 'direct', botIds: [bot.id] })
    this.created(bot, conversation)
    return { bot, conversation }
  }

  /** A bot another bot creates (`create_bot`); the creator's chat gets a line about it. */
  createFromTool(input: NewBotInput, creator: Bot): Bot {
    const { store } = this.deps
    const bot = store.bots.create({
      name: input.name,
      label: input.label,
      systemPrompt: input.systemPrompt,
      ...((input.model === null ? this.deps.newBotModel() : null) ?? {
        model: input.model,
        providerId: creator.providerId,
      }),
      ...(input.avatar ? { avatar: input.avatar } : {}),
    })
    const conversation = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    this.created(bot, conversation)
    const origin = store.conversations.findDirect(creator.id)
    if (origin) {
      this.deps.messages.append({
        conversationId: origin.id,
        authorType: 'system',
        kind: 'system_event',
        content: `${creator.name} created ${bot.name}`,
        payload: {
          type: 'system',
          event: 'bot_created',
          botId: bot.id,
          params: {
            creatorBotId: creator.id,
            creatorName: creator.name,
            botName: bot.name,
            conversationId: conversation.id,
          },
        },
      })
    }
    return bot
  }

  /** `userEdit`: the user changed the persona in the app (a new prompt version is recorded). */
  update(id: string, patch: Partial<NewBot>, options: { userEdit?: boolean } = {}): Bot {
    const { store } = this.deps
    const bot =
      options.userEdit && patch.systemPrompt !== undefined
        ? this.deps.prompts.trackUserEdit(id, () => store.bots.update(id, patch))
        : store.bots.update(id, patch)
    this.deps.emit({ type: 'bot.updated', payload: { bot } })
    return bot
  }

  /** Soft delete; the bot's work stops and its Linux user/desktop leaves the VM (now or at the next boot). */
  delete(botId: string): void {
    const { store, emit } = this.deps
    const bot = store.bots.assertDeletable(botId)
    const groupsOfBot = store.conversations
      .list()
      .filter((c) => c.type === 'group' && c.memberBotIds.includes(botId))
    for (const listener of this.deleting) listener(botId)
    const { deletedConversationIds } = store.deleteBot(botId)
    for (const listener of this.deleted) listener(botId)
    void this.removeFromVm(bot)
    emit({ type: 'bot.deleted', payload: { botId } })
    for (const conversationId of deletedConversationIds) {
      emit({ type: 'conversation.deleted', payload: { conversationId } })
    }
    for (const group of groupsOfBot) this.deps.messages.conversationUpdated(group.id)
  }

  /** The first bot introduces itself when its DM is empty (not while the workspace is being set up). */
  introduceFirstBot(): void {
    const { store } = this.deps
    if (store.settings.get(SETUP_PENDING_KEY, false)) return
    const bot = store.bots.first()
    const dm = bot ? store.conversations.findDirect(bot.id) : null
    if (bot && dm && !dm.lastMessage) {
      this.deps.host.enqueueTurn({ botId: bot.id, conversationId: dm.id, trigger: 'intro' })
    }
  }

  handlers(): EndpointHandlers<BotEndpoint> {
    const { store, vm, host } = this.deps
    return {
      listBots: () => store.bots.list(),
      createBot: ({ body }) => this.create(body),
      updateBot: ({ params, body }) => this.update(params.botId, body, { userEdit: true }),
      deleteBot: ({ params }) => {
        this.delete(params.botId)
        return { ok: true as const }
      },
      getBotDisplay: ({ params }) => {
        const bot = store.bots.get(params.botId)
        const vncPort = vm.vncPort(bot.displayNum)
        if (vncPort === null) throw new DaemonError('conflict', 'The workspace VM has not been created yet')
        const screen = host.screenState(bot.id)
        return {
          display: bot.displayNum,
          vncHost: '127.0.0.1' as const,
          vncPort,
          width: 1280 as const,
          height: 800 as const,
          control: screen.control,
          paused: screen.paused,
          busy: screen.busy,
        }
      },
      controlBot: ({ params, body }) => {
        store.bots.get(params.botId)
        const { action, ...options } = body
        const screen = host.control(params.botId, action, options)
        return { ok: true as const, paused: screen.paused, control: screen.control }
      },
      getBotActivity: ({ params, query }) => {
        store.bots.get(params.botId)
        return this.deps.toolCalls.botActivity(params.botId, query.limit)
      },
    }
  }

  private created(bot: Bot, conversation: ConversationSummary): void {
    const { emit, vm, host, log } = this.deps
    emit({ type: 'bot.created', payload: { bot } })
    emit({ type: 'conversation.created', payload: { conversation } })
    const desktop = vm
      .provisionBot(bot)
      .then(() => this.deps.provisioned(bot))
      .catch((err: unknown) =>
        log('warn', 'desktop provisioning failed', { botId: bot.id, err: errorMessage(err) }),
      )
    host.enqueueTurn({ botId: bot.id, conversationId: conversation.id, trigger: 'intro', waitFor: desktop })
  }

  private async removeFromVm(bot: Bot): Promise<void> {
    const { host, vm, log } = this.deps
    await host.forgetBot(bot.id).catch(() => undefined)
    await this.deps.forgetCredentials(bot.id).catch(() => undefined)
    try {
      const removed = await vm.removeBot(bot.slug)
      if (!removed) log('info', 'bot removal from the VM deferred to the next boot', { slug: bot.slug })
    } catch (err) {
      log('warn', 'bot removal from the VM failed; retried on the next boot', {
        slug: bot.slug,
        err: errorMessage(err),
      })
    }
  }
}
