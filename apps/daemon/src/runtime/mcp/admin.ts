import type { AgentHost, NewAgentMessage, ToolExecContext } from '@milibot/agent'
import {
  type Bot,
  type BotScope,
  type ConfirmationPayload,
  type LogFn,
  type McpKeyValueInput,
  type McpServer,
  type McpSignInPayload,
  type McpTransport,
  type Message,
  type MessagePayload,
  secretRefRegex,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import type { ConfirmationAction, ConfirmationHandler, ConfirmationParams } from '../groups'
import { stopped } from '../tools-core'
import type { McpSignInOutcome } from './oauth'
import type { McpService } from './service'
import {
  connectedText,
  goneText,
  noSignInText,
  pendingText,
  rejectedText,
  removedText,
  signInOutcomeText,
  signInStartedText,
  testText,
  unchangedConnectionText,
} from './texts'

/** A header or variable as the bot proposed it: `{{secret:NAME}}` references stay unresolved until applied. */
export interface ProposedKeyValue {
  name: string
  /** Absent (updates only): keep the stored value. */
  value?: string
}

export interface ProposedServer {
  name: string
  transport: McpTransport
  command: string | null
  args: string[]
  url: string | null
  headers: ProposedKeyValue[]
  env: ProposedKeyValue[]
  allowedBots: BotScope
}

export type ProposedChanges = Partial<ProposedServer> & { enabled?: boolean }

/** What the confirmation stores for its handler (the card shows `McpCardDetails`). */
export type Proposal =
  | { kind: 'add'; server: ProposedServer }
  | { kind: 'update'; serverId: string; changes: ProposedChanges }
  | { kind: 'remove'; serverId: string }
  /** A bot's own switches (`bot_mcp_set`); `allow`: the bot joins the server's access list. */
  | { kind: 'bot'; botId: string; changes: Array<{ serverId: string; on: boolean; allow: boolean }> }

/** The confirmation card's `details` param (JSON): what the user is asked to approve, without secret values. */
export interface McpCardDetails {
  /** A new name (changes). */
  name?: string
  transport?: McpTransport
  target?: string
  headers?: ProposedKeyValue[]
  env?: ProposedKeyValue[]
  /** Bot names, or 'all'. */
  bots?: string[] | 'all'
  enabled?: boolean
}

/** The `bot_mcp` card's `details` param (JSON). */
interface BotMcpCardDetails {
  changes: Array<{
    server: string
    on: boolean
    /** Names of the server's tools the bot gets (or loses). */
    tools: string[]
    /** The bot is not on the server's access list: approving also gives it access. */
    allow: boolean
  }>
}

const ACTION: Record<Proposal['kind'], ConfirmationAction> = {
  add: 'mcp_add',
  update: 'mcp_update',
  remove: 'mcp_remove',
  bot: 'bot_mcp',
}

const NOT_MANAGER = 'Only a bot that manages the team (team-management skill on) can do this.'

export interface McpAdminDeps {
  mcp: Pick<
    McpService,
    | 'listServers'
    | 'getServer'
    | 'createServer'
    | 'updateServer'
    | 'deleteServer'
    | 'testServer'
    | 'startSignIn'
    | 'signInOutcome'
    | 'setBotServer'
  >
  confirmations: {
    request(input: {
      bot: Bot
      conversationId: string | null
      action: ConfirmationAction
      params: ConfirmationParams
      reason: string
      data: Record<string, unknown>
    }): Message
    onConfirmed(action: ConfirmationAction, handler: ConfirmationHandler): void
    onRejected(action: ConfirmationAction, handler: ConfirmationHandler): void
  }
  host: Pick<AgentHost, 'enqueueTurn'>
  findBot: (id: string) => Bot | null
  listBots: () => Bot[]
  /** The bot has the team-management skill active (`bot_mcp_set`). */
  managesTeam: (bot: Bot) => boolean
  cardConversation: (bot: Bot, conversationId: string | null) => string
  /** `{{secret:NAME}}` → the value among the bot's secrets (throws for a name it cannot use). */
  resolveSecretRefs: (bot: Bot, text: string) => string
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  /** Pending sign-in cards (left by a previous runtime). */
  pendingSignInCards: () => Array<{ id: string; payload: unknown }>
  timeoutSeconds: () => number
  log: LogFn
}

const hasSecretRef = (value: string | undefined): boolean =>
  value !== undefined && secretRefRegex().test(value)

/**
 * Bot-driven management of the workspace's MCP servers: every add, change and removal waits for the user's
 * confirmation card, then runs through `McpService` (the same path as the settings screen) and is tested;
 * an OAuth sign-in posts a card with the link and waits for its outcome. The tool waits like `ask_user`
 * (detached); what ends after it stopped waiting reaches the bot as a `user_answer` turn.
 */
export class McpAdmin {
  private readonly waiters = new Map<string, (text: string) => void>()
  private signIns = 0

  constructor(private readonly deps: McpAdminDeps) {
    for (const kind of ['add', 'update', 'remove', 'bot'] as const) {
      deps.confirmations.onConfirmed(ACTION[kind], (input) => this.approved(input))
      deps.confirmations.onRejected(ACTION[kind], (input) => this.rejected(input))
    }
  }

  /** Sign-in cards of a previous runtime point at a loopback listener that is gone. */
  start(): void {
    for (const card of this.deps.pendingSignInCards()) {
      const payload = card.payload as McpSignInPayload
      this.deps.updateMessage(card.id, {
        payload: { ...payload, status: 'expired' },
        content: this.signInContent(payload.serverName, 'expired'),
      })
    }
  }

  stop(): void {
    this.waiters.clear()
  }

  list(): McpServer[] {
    return this.deps.mcp.listServers()
  }

  /** Asks the user to approve adding a server and waits for the outcome (test and sign-in included). */
  propose(
    ctx: ToolExecContext,
    proposal: Proposal,
    card: { serverName: string; details: McpCardDetails; reason: string },
  ): Promise<string> {
    const message = this.deps.confirmations.request({
      bot: ctx.bot,
      conversationId: ctx.conversationId,
      action: ACTION[proposal.kind],
      params: {
        botId: ctx.bot.id,
        botName: ctx.bot.name,
        serverName: card.serverName,
        details: JSON.stringify(card.details),
      },
      reason: card.reason,
      data: { proposal },
    })
    const { confirmationId } = message.payload as ConfirmationPayload
    return this.wait(ctx, confirmationId)
  }

  /** Asks the user to approve turning servers on or off for a bot (`bot` is the bot changed). */
  proposeBot(
    ctx: ToolExecContext,
    bot: Bot,
    changes: Array<{ server: McpServer; on: boolean; allow: boolean }>,
    reason: string,
  ): Promise<string> {
    if (!this.deps.managesTeam(ctx.bot)) throw new DaemonError('validation_failed', NOT_MANAGER)
    const details: BotMcpCardDetails = {
      changes: changes.map((c) => ({
        server: c.server.name,
        on: c.on,
        tools: c.server.tools.map((t) => t.name),
        allow: c.allow,
      })),
    }
    const proposal: Proposal = {
      kind: 'bot',
      botId: bot.id,
      changes: changes.map((c) => ({ serverId: c.server.id, on: c.on, allow: c.allow })),
    }
    const message = this.deps.confirmations.request({
      bot: ctx.bot,
      conversationId: ctx.conversationId,
      action: ACTION.bot,
      params: {
        botId: bot.id,
        botName: bot.name,
        serverName: changes.map((c) => c.server.name).join(', '),
        details: JSON.stringify(details),
      },
      reason,
      data: { proposal },
    })
    const { confirmationId } = message.payload as ConfirmationPayload
    return this.wait(ctx, confirmationId)
  }

  /** Tests a server (reconnects and lists its tools). */
  async test(serverId: string): Promise<string> {
    const result = await this.deps.mcp.testServer(serverId)
    return testText(this.deps.mcp.getServer(serverId), result, this.deps.listBots())
  }

  /** Starts a sign-in with a card in the chat and waits for its outcome. */
  connect(ctx: ToolExecContext, serverId: string): Promise<string> {
    const key = `sign-in:${++this.signIns}`
    const waiting = this.wait(ctx, key)
    const conversationId = this.deps.cardConversation(ctx.bot, ctx.conversationId)
    void this.signIn(ctx.bot, conversationId, serverId)
      .catch((err: unknown) => `Could not start the sign-in: ${errorMessage(err)}`)
      .then((text) => this.settle(key, ctx.bot.id, conversationId, text))
    return waiting
  }

  private wait(ctx: ToolExecContext, key: string): Promise<string> {
    const seconds = this.deps.timeoutSeconds()
    const wait = new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        this.waiters.delete(key)
      }
      const onAbort = () => {
        cleanup()
        reject(stopped())
      }
      const timer = setTimeout(
        () => {
          cleanup()
          resolve(pendingText(seconds))
        },
        Math.max(10, seconds * 1000),
      )
      this.waiters.set(key, (text) => {
        cleanup()
        resolve(text)
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal.aborted) onAbort()
    })
    return ctx.detach ? ctx.detach(wait) : wait
  }

  /** Hands the outcome to the waiting tool call, else to the bot as a new turn. */
  private settle(key: string, botId: string, conversationId: string, text: string): void {
    const waiter = this.waiters.get(key)
    if (waiter) {
      waiter(text)
      return
    }
    if (!this.deps.findBot(botId)) return
    this.deps.host.enqueueTurn({
      botId,
      conversationId,
      trigger: 'user_answer',
      note: `[Milibot] ${text}`,
    })
  }

  private proposalOf(data: Record<string, unknown>): Proposal | null {
    const proposal = data.proposal as Proposal | undefined
    return proposal && typeof proposal === 'object' && 'kind' in proposal ? proposal : null
  }

  private rejected(input: Parameters<ConfirmationHandler>[0]): void {
    const proposal = this.proposalOf(input.data)
    if (!proposal) return
    const name = input.params.serverName ?? ''
    this.settle(
      input.confirmationId,
      input.requesterId,
      input.conversationId,
      proposal.kind === 'bot'
        ? `The user declined changing the MCP servers of ${input.params.botName}. Nothing changed.`
        : rejectedText(proposal.kind, name),
    )
  }

  private approved(input: Parameters<ConfirmationHandler>[0]): void {
    const proposal = this.proposalOf(input.data)
    const bot = this.deps.findBot(input.requesterId)
    if (!proposal || !bot) return
    if (proposal.kind === 'bot') {
      this.approvedBot(input, bot, proposal)
      return
    }
    if (proposal.kind !== 'add') {
      try {
        this.deps.mcp.getServer(proposal.serverId)
      } catch (err) {
        const name = input.params.serverName ?? ''
        this.settle(input.confirmationId, bot.id, input.conversationId, goneText(proposal.kind, name))
        throw err
      }
    }
    void this.apply(bot, input.conversationId, proposal)
      .catch((err: unknown) => {
        this.deps.log('warn', 'mcp server change failed', { err: errorMessage(err) })
        return `It did not work: ${errorMessage(err)}`
      })
      .then((text) => this.settle(input.confirmationId, bot.id, input.conversationId, text))
  }

  private approvedBot(
    input: Parameters<ConfirmationHandler>[0],
    requester: Bot,
    proposal: Extract<Proposal, { kind: 'bot' }>,
  ): void {
    const settle = (text: string) =>
      this.settle(input.confirmationId, requester.id, input.conversationId, text)
    const target = this.deps.findBot(proposal.botId)
    const servers = new Set(this.deps.mcp.listServers().map((s) => s.id))
    const live = proposal.changes.filter((c) => servers.has(c.serverId))
    const problem = !this.deps.managesTeam(requester)
      ? `you no longer manage the team. ${NOT_MANAGER}`
      : !target
        ? `${input.params.botName} no longer exists.`
        : live.length === 0
          ? 'the MCP servers no longer exist.'
          : null
    if (problem || !target) {
      settle(`Not applied: ${problem}`)
      throw new DaemonError('conflict', problem ?? 'gone')
    }
    void this.applyBot(target, live)
      .catch((err: unknown) => `It did not work: ${errorMessage(err)}`)
      .then(settle)
  }

  private async applyBot(
    target: Bot,
    changes: Array<{ serverId: string; on: boolean; allow: boolean }>,
  ): Promise<string> {
    const { mcp } = this.deps
    const done: string[] = []
    for (const change of changes) {
      let server = mcp.getServer(change.serverId)
      if (change.allow && server.allowedBots !== 'all' && !server.allowedBots.includes(target.id))
        server = await mcp.updateServer(server.id, { allowedBots: [...server.allowedBots, target.id] })
      mcp.setBotServer(target.id, server.id, { enabled: change.on })
      const off = change.on && !server.enabled ? ' (the server itself is turned off)' : ''
      done.push(`${server.name} ${change.on ? 'on' : 'off'}${off}`)
    }
    return `The user approved. MCP servers of ${target.name}: ${done.join(', ')}. It takes effect from ${target.name}'s next turn.`
  }

  private keyValues(bot: Bot, items: ProposedKeyValue[]): McpKeyValueInput[] {
    return items.map((item) =>
      item.value === undefined
        ? { name: item.name, value: null, secret: true }
        : hasSecretRef(item.value)
          ? { name: item.name, value: this.deps.resolveSecretRefs(bot, item.value), secret: true }
          : { name: item.name, value: item.value, secret: false },
    )
  }

  private async apply(
    bot: Bot,
    conversationId: string,
    proposal: Exclude<Proposal, { kind: 'bot' }>,
  ): Promise<string> {
    const { mcp } = this.deps
    if (proposal.kind === 'remove') {
      const server = mcp.getServer(proposal.serverId)
      await mcp.deleteServer(server.id)
      return removedText(server.name)
    }
    if (proposal.kind === 'add') {
      const p = proposal.server
      const server = await mcp.createServer({
        name: p.name,
        transport: p.transport,
        command: p.command,
        args: p.args,
        url: p.url,
        headers: this.keyValues(bot, p.headers),
        env: this.keyValues(bot, p.env),
        enabled: true,
        allowedBots: p.allowedBots,
      })
      return this.afterChange(bot, conversationId, server.id, 'added')
    }
    const c = proposal.changes
    const before = mcp.getServer(proposal.serverId)
    const keep = (items: ProposedKeyValue[], stored: McpServer['headers']): ProposedKeyValue[] =>
      items.map((item) => {
        if (item.value !== undefined) return item
        const had = stored.find((s) => s.name === item.name)
        return had && !had.secret ? { name: item.name, value: had.value ?? '' } : item
      })
    const server = await mcp.updateServer(proposal.serverId, {
      ...(c.name !== undefined ? { name: c.name } : {}),
      ...(c.transport !== undefined ? { transport: c.transport } : {}),
      ...(c.command !== undefined ? { command: c.command } : {}),
      ...(c.args !== undefined ? { args: c.args } : {}),
      ...(c.url !== undefined ? { url: c.url } : {}),
      ...(c.headers !== undefined ? { headers: this.keyValues(bot, keep(c.headers, before.headers)) } : {}),
      ...(c.env !== undefined ? { env: this.keyValues(bot, keep(c.env, before.env)) } : {}),
      ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
      ...(c.allowedBots !== undefined ? { allowedBots: c.allowedBots } : {}),
    })
    const connection = ['transport', 'command', 'args', 'url', 'headers', 'env', 'enabled'] as const
    if (!server.enabled || !connection.some((field) => c[field] !== undefined))
      return unchangedConnectionText(server, this.deps.listBots())
    return this.afterChange(bot, conversationId, server.id, 'changed')
  }

  /** Tests the server; when it asks for a sign-in, starts one with a card and waits for it. */
  private async afterChange(
    bot: Bot,
    conversationId: string,
    serverId: string,
    what: 'added' | 'changed',
  ): Promise<string> {
    const { mcp } = this.deps
    const result = await mcp.testServer(serverId)
    const server = mcp.getServer(serverId)
    const tested = testText(server, result, this.deps.listBots(), what)
    if (result.ok || !result.authRequired || server.transport !== 'http') return tested
    return `${tested}\n\n${await this.signIn(bot, conversationId, serverId)}`
  }

  private async signIn(bot: Bot, conversationId: string, serverId: string): Promise<string> {
    const { mcp } = this.deps
    const server = mcp.getServer(serverId)
    if (server.transport !== 'http') return noSignInText(server.name)
    const url = await mcp.startSignIn(serverId)
    if (!url) {
      const result = await mcp.testServer(serverId)
      return connectedText(
        mcp.getServer(serverId),
        null,
        result.ok ? null : result.error,
        this.deps.listBots(),
      )
    }
    const outcome = mcp.signInOutcome(serverId)
    const card = this.deps.appendMessage({
      conversationId,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'card',
      content: this.signInContent(server.name, 'pending'),
      payload: {
        type: 'mcp_sign_in',
        serverId,
        serverName: server.name,
        botId: bot.id,
        authorizationUrl: url,
        status: 'pending',
      },
    })
    if (!outcome) return signInStartedText(server.name)
    const result = await outcome
    this.finishCard(card, result)
    if (result.status !== 'connected') return signInOutcomeText(server.name, result)
    return connectedText(mcp.getServer(serverId), result.account, null, this.deps.listBots())
  }

  private finishCard(card: Message, outcome: McpSignInOutcome): void {
    const payload = card.payload as McpSignInPayload
    try {
      this.deps.updateMessage(card.id, {
        content: this.signInContent(payload.serverName, outcome.status),
        payload: {
          ...payload,
          status: outcome.status,
          ...(outcome.status === 'connected' ? { account: outcome.account } : {}),
          ...(outcome.status === 'failed' ? { error: outcome.error.slice(0, 300) } : {}),
        },
      })
    } catch (err) {
      this.deps.log('warn', 'mcp sign-in card update failed', { err: errorMessage(err) })
    }
  }

  private signInContent(serverName: string, status: McpSignInPayload['status']): string {
    return status === 'pending'
      ? `Sign-in to the MCP server ${serverName}: open the link to connect`
      : `Sign-in to the MCP server ${serverName}: ${status}`
  }
}
