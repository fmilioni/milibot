import {
  type Bot,
  type BotMessageReceivedPayload,
  type BotMessageSentPayload,
  clipLine,
  type ConversationSummary,
  findBotByRef,
  GROUP_SETTING_KEYS,
  newId,
} from '@milibot/shared'

import type { ActivePlan, ToolResult } from '../../environment'
import { botFollowUpNote, botNoticeNote, botReplyNote, planRequestNote } from '../../prompts/notes'
import { messagingReplies } from '../../prompts/tool-replies'
import { argsObject, trimmedString } from '../../tools/args'
import { toolError, toolText } from '../../tools/result'
import type { HostContext } from '../context'
import { laneInfo, type LaneKey } from '../lanes'
import { StoppedError, type TurnState } from '../state'
import type { HostToolCall } from '../tools/host-tools'

const DEFAULT_ASK_TIMEOUT_SECONDS = 300
/** Nested ask_bot/message_bot calls (A asks B asks C). */
const MAX_CHAIN = 3
/** Bot-to-bot hops since the last user message, replies included (a safety net under the pause). */
const MAX_HOPS = 8
/** Round trips between bots after which a new message waits for the user's OK (confirmation card). */
const PAUSE_BOT_EXCHANGE_AT = 3

/** A bot message held for the user's OK after a long bot-to-bot exchange. */
interface HeldBotMessage {
  fromBotId: string
  toBotId: string
  originConversationId: string
  text: string
  notice: boolean
}

/** A message from one bot to another (ask_bot/message_bot) waiting for the answer. */
export interface BotRequest {
  id: string
  fromBotId: string
  toBotId: string
  originConversationId: string
  cardMessageId: string
  card: BotMessageSentPayload
  /** The card in the target's own chat, when it has one. */
  received: { messageId: string; card: BotMessageReceivedPayload } | null
  callerChain: string[]
  callerHops: number
  /** An update (message_bot with expects_reply false): the target's reply is not delivered back. */
  notice: boolean
  /** Set while the asker waits for the reply inside its tool call (ask_bot). */
  waiter: ((reply: string) => void) | null
  /** The asker stopped waiting (the user stopped its turn): the reply only updates the card. */
  abandoned: boolean
}

type AskOutcome = { reply: string } | 'timeout' | 'aborted'

/** ask_bot/message_bot between bots: the requests in flight, held messages and follow-ups. */
export class BotMessaging {
  private readonly requests = new Map<string, BotRequest>()
  private readonly heldMessages = new Map<string, HeldBotMessage>()
  /** Asking lane → bot it is waiting on (ask_bot), to refuse asks that would deadlock. */
  private readonly waitingOn = new Map<LaneKey, string>()
  /** `<internalConversationId>:<askerId>` → where the asker last wrote from, for follow-ups. */
  private readonly internalOrigins = new Map<string, { conversationId: string; chain: string[] }>()

  constructor(private readonly ctx: HostContext) {}

  /** Requests other bots made to `botId` that it has not answered yet. */
  requestsTo(botId: string): BotRequest[] {
    return [...this.requests.values()].filter((r) => r.toBotId === botId)
  }

  /** Conversations the bots of an internal conversation last wrote to it from. */
  origins(internalConversationId: string): string[] {
    return [...this.internalOrigins]
      .filter(([key]) => key.startsWith(`${internalConversationId}:`))
      .map(([, link]) => link.conversationId)
  }

  /** The bot is gone: what others asked it fails. */
  dropBot(botId: string): void {
    for (const request of this.requestsTo(botId)) this.finish(request.id, '')
  }

  /** An empty reply means the target could not answer (failed, stopped or deleted). */
  finish(id: string, reply: string): void {
    const request = this.requests.get(id)
    if (!request) return
    this.requests.delete(id)
    const env = this.ctx.env()
    const name = env.getBot(request.toBotId)?.name ?? 'The bot'
    const outcome = {
      status: request.notice ? ('delivered' as const) : reply ? ('replied' as const) : ('failed' as const),
      ...(reply ? { replyPreview: clipLine(reply, 280) } : {}),
    }
    try {
      env.updateMessage(request.cardMessageId, { payload: { ...request.card, ...outcome } })
      if (request.received)
        env.updateMessage(request.received.messageId, { payload: { ...request.received.card, ...outcome } })
    } catch (err) {
      env.log('warn', 'bot message card update failed', { err: (err as Error).message })
    }
    if (request.waiter) {
      request.waiter(reply)
      return
    }
    if (request.notice || request.abandoned || !this.ctx.running() || !env.getBot(request.fromBotId)) return
    this.ctx.scheduler.enqueue({
      botId: request.fromBotId,
      conversationId: request.originConversationId,
      trigger: 'bot_reply',
      note: botReplyNote(name, request.card.preview, reply),
      chain: request.callerChain,
      hops: request.callerHops + 1,
    })
  }

  /**
   * Text a bot wrote in an internal conversation outside of answering a request (e.g. after a reply it
   * was waiting on from a third bot) would otherwise never reach the other bot: deliver it like a
   * message_bot reply, as a new turn in the conversation the other bot last wrote from.
   */
  followUp(bot: Bot, turn: TurnState, conversation: ConversationSummary, text: string): void {
    const env = this.ctx.env()
    const peerId = conversation.memberBotIds.find((id) => id !== bot.id)
    const peer = peerId ? env.getBot(peerId) : null
    if (!peer) return
    const hops = turn.hops + 1
    if (hops > MAX_HOPS) {
      env.log('info', 'internal follow-up not delivered: too many hops', { botId: bot.id, hops })
      return
    }
    const link = this.internalOrigins.get(`${conversation.id}:${peer.id}`)
    const origin = link?.conversationId ?? env.findDirectConversation(peer.id)?.id
    if (!origin || origin === conversation.id) return
    this.ctx.scheduler.enqueue({
      botId: peer.id,
      conversationId: origin,
      trigger: 'bot_reply',
      note: botFollowUpNote(bot.name, text),
      chain: link?.chain ?? [],
      hops,
    })
  }

  findBotRef(ref: string): Bot | null {
    return findBotByRef(this.ctx.env().listBots(), ref)
  }

  private wouldDeadlock(asker: string, target: string): boolean {
    const seen = new Set<string>()
    const pending = [target]
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (current === asker) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const [laneKey, waitedOn] of this.waitingOn)
        if (laneInfo(laneKey).botId === current) pending.push(waitedOn)
    }
    return false
  }

  /**
   * ask_bot / message_bot: posts the message in the internal conversation of the two bots, shows a
   * card in the asker's conversation and runs the target's turn there. ask_bot waits (bounded) for
   * the reply; message_bot (or an ask that timed out) wakes the asker later with the reply.
   */
  async messageBot({ bot, turn, conversationId, call, signal }: HostToolCall): Promise<ToolResult> {
    const env = this.ctx.env()
    const ask = call.name === 'ask_bot'
    const a = argsObject(call.arguments)
    const ref = trimmedString(a.bot)
    const text = trimmedString(a.message)
    if (!ref || !text) return toolError(messagingReplies.missingArgs)
    const target = this.findBotRef(ref)
    if (!target) return toolError(messagingReplies.noSuchBot(ref))
    if (target.id === bot.id) return toolError(messagingReplies.self)
    const chain = turn?.chain ?? []
    const hops = turn?.hops ?? 0
    if (chain.includes(target.id)) return toolError(messagingReplies.targetWaiting(target.name))
    if (chain.length >= MAX_CHAIN || hops >= MAX_HOPS) return toolError(messagingReplies.chainTooLong)
    if (ask && this.wouldDeadlock(bot.id, target.id))
      return toolError(messagingReplies.wouldDeadlock(target.name))

    const origin = conversationId ?? env.findDirectConversation(bot.id)?.id
    if (!origin) return toolError(messagingReplies.noConversation)
    const notice = !ask && a.expects_reply === false
    if (hops >= PAUSE_BOT_EXCHANGE_AT) {
      const heldId = newId('botRequest')
      this.heldMessages.set(heldId, {
        fromBotId: bot.id,
        toBotId: target.id,
        originConversationId: origin,
        text,
        notice,
      })
      env.requestConfirmation({
        botId: bot.id,
        conversationId: origin,
        action: 'continue_bot_exchange',
        params: { botId: target.id, botName: target.name },
        reason: clipLine(text, 280),
        data: { heldId },
      })
      return toolText(messagingReplies.heldForUser(target.name))
    }
    const request = this.send({
      bot,
      target,
      origin,
      text,
      ask,
      notice,
      chain,
      hops,
      turnId: turn?.id ?? null,
      plan: turn ? env.activePlan(bot, turn.laneKey, conversationId) : null,
    })
    if (!ask)
      return toolText(notice ? messagingReplies.sentNotice(target.name) : messagingReplies.sent(target.name))

    const timeoutSeconds = env.getSetting<number>(
      GROUP_SETTING_KEYS.askTimeoutSeconds,
      DEFAULT_ASK_TIMEOUT_SECONDS,
    )
    const askingLane = this.ctx.lanes.laneOf(bot.id, turn)
    this.waitingOn.set(askingLane.info.key, target.id)
    let outcome: AskOutcome
    try {
      // A waiting asker does not hold a parallel slot, so the target (or others) can run.
      outcome = await this.ctx.scheduler.detached(
        askingLane,
        turn,
        new Promise<AskOutcome>((resolve) => {
          const done = (value: AskOutcome) => {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            request.waiter = null
            resolve(value)
          }
          const onAbort = () => done('aborted')
          const timer = setTimeout(() => done('timeout'), Math.max(10, timeoutSeconds * 1000))
          signal.addEventListener('abort', onAbort, { once: true })
          request.waiter = (reply) => done({ reply })
          if (signal.aborted) done('aborted')
        }),
      )
    } finally {
      this.waitingOn.delete(askingLane.info.key)
    }
    if (outcome === 'aborted') {
      request.abandoned = true
      throw new StoppedError()
    }
    if (outcome === 'timeout') return toolText(messagingReplies.askTimedOut(target.name, timeoutSeconds))
    if (!outcome.reply) return toolError(messagingReplies.askFailed(target.name))
    return toolText(messagingReplies.answered(target.name, outcome.reply))
  }

  /** The user let a paused bot-to-bot exchange go on: sends the held message, with the hop count reset. */
  resume(heldId: string): boolean {
    const held = this.heldMessages.get(heldId)
    if (!held) return false
    this.heldMessages.delete(heldId)
    const env = this.ctx.env()
    const bot = env.getBot(held.fromBotId)
    const target = env.getBot(held.toBotId)
    if (!bot || !target) return false
    this.send({
      bot,
      target,
      origin: held.originConversationId,
      text: held.text,
      ask: false,
      notice: held.notice,
      chain: [],
      hops: 0,
      turnId: null,
      plan: null,
    })
    return true
  }

  /** Posts a bot message in the pair's internal conversation, with its cards, and runs the target's turn. */
  private send(input: {
    bot: Bot
    target: Bot
    origin: string
    text: string
    ask: boolean
    notice: boolean
    chain: string[]
    hops: number
    turnId: string | null
    plan: ActivePlan | null
  }): BotRequest {
    const env = this.ctx.env()
    const { bot, target, origin, text, chain, hops, turnId } = input
    const internal = env.internalConversation(bot.id, target.id)
    this.internalOrigins.set(`${internal.id}:${bot.id}`, { conversationId: origin, chain })
    env.appendMessage({
      conversationId: internal.id,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'text',
      content: text,
      payload: { type: 'text', streaming: false, turnId },
      turnId,
    })
    const card: BotMessageSentPayload = {
      type: 'bot_message_sent',
      targetBotId: target.id,
      internalConversationId: internal.id,
      preview: clipLine(text, 280),
      awaitReply: input.ask,
      ...(input.notice ? { notice: true } : {}),
      status: 'waiting',
    }
    const cardMessage = env.appendMessage({
      conversationId: origin,
      authorType: 'bot',
      authorBotId: bot.id,
      kind: 'card',
      content: `Message sent to ${target.name}: ${card.preview}`,
      payload: card,
      turnId,
    })
    const request: BotRequest = {
      id: newId('botRequest'),
      fromBotId: bot.id,
      toBotId: target.id,
      originConversationId: origin,
      cardMessageId: cardMessage.id,
      card,
      received: this.receivedCard(bot, target, internal.id, card.preview),
      callerChain: chain,
      callerHops: hops,
      notice: input.notice,
      waiter: null,
      abandoned: false,
    }
    this.requests.set(request.id, request)
    const note = [
      input.notice ? botNoticeNote(bot.name) : null,
      input.plan ? planRequestNote(bot.name, input.plan) : null,
    ]
      .filter(Boolean)
      .join('\n\n')
    this.ctx.scheduler.enqueue({
      botId: target.id,
      conversationId: internal.id,
      trigger: 'bot_message',
      botRequests: [request.id],
      // An update leaves nobody waiting: the target may message the sender back.
      chain: input.notice ? chain : [...chain, bot.id],
      hops: hops + 1,
      ...(note ? { note } : {}),
    })
    return request
  }

  /** Shows the message in the target's own chat too, so the user sees what its bot was asked from there. */
  private receivedCard(
    from: Bot,
    target: Bot,
    internalConversationId: string,
    preview: string,
  ): BotRequest['received'] {
    const env = this.ctx.env()
    const direct = env.findDirectConversation(target.id)
    if (!direct) return null
    const card: BotMessageReceivedPayload = {
      type: 'bot_message_received',
      fromBotId: from.id,
      internalConversationId,
      preview,
      status: 'waiting',
    }
    try {
      const message = env.appendMessage({
        conversationId: direct.id,
        authorType: 'system',
        kind: 'card',
        content: `[Milibot] ${from.name} sent ${target.name} a message in their private conversation (answered there): ${preview}`,
        payload: card,
        turnId: null,
      })
      return { messageId: message.id, card }
    } catch (err) {
      env.log('warn', 'received message card failed', { err: (err as Error).message })
      return null
    }
  }
}
