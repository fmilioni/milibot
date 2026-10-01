import {
  type Bot,
  type ConversationSummary,
  firstBot,
  GROUP_SETTING_KEYS,
  type Message,
} from '@milibot/shared'

import { CLI_ENGINE_DRIVERS } from '../../cli/registry'
import { isCliModel } from '../../environment'
import { DEFAULT_BOT_COOLDOWN_SECONDS, parseTriageResponse, planGroupRoute } from '../../groups/routing'
import { buildTriagePrompt, TRIAGE_SYSTEM_PROMPT } from '../../prompts/triage'
import type { HostContext } from '../context'
import { userTurn } from '../scheduling/scheduler'
import { HISTORY_MESSAGES } from '../state'
import { oneShot, oneShotEstimate } from '../turn/one-shot'

/** Which bots a user message wakes: every member of a direct chat, the members a group routes it to. */
export class GroupRouting {
  /** Group routing (triage) in flight. */
  private readonly routing = new Set<Promise<void>>()
  /** Last time each bot spoke in each group (`botId:conversationId`), for the cooldown. */
  private readonly spokeAt = new Map<string, number>()

  constructor(private readonly ctx: HostContext) {}

  pending(): Array<Promise<void>> {
    return [...this.routing]
  }

  onUserMessage(message: Message): void {
    const conversation = this.ctx.env().getConversation(message.conversationId)
    if (!conversation || conversation.type === 'internal') return
    if (conversation.type === 'group') {
      this.route(message, conversation)
      return
    }
    for (const botId of conversation.memberBotIds)
      this.ctx.scheduler.enqueue(userTurn(botId, conversation.id))
  }

  /** The bot wrote in a group: the cooldown starts and the other members may react to its last message. */
  botSpoke(bot: Bot, conversation: ConversationSummary, last: Message, stopped: boolean): void {
    this.spokeAt.set(`${bot.id}:${conversation.id}`, this.ctx.env().now())
    if (!stopped && this.ctx.running()) this.route(last, conversation)
  }

  /** Decides in the background which group members answer `message` (mentions, triage, loop guards). */
  private route(message: Message, conversation: ConversationSummary): void {
    const task = this.routeGroupMessage(message, conversation).catch((err: unknown) =>
      this.ctx.env().log('warn', 'group routing failed', {
        conversationId: conversation.id,
        err: (err as Error).message,
      }),
    )
    this.routing.add(task)
    void task.finally(() => {
      this.routing.delete(task)
      this.ctx.scheduler.notifyIdle()
    })
  }

  private async routeGroupMessage(message: Message, conversation: ConversationSummary): Promise<void> {
    const env = this.ctx.env()
    const bots = this.ctx.botsById()
    const recent = env.recentMessages(conversation.id, HISTORY_MESSAGES)
    const cooldownSeconds = env.getSetting<number>(
      GROUP_SETTING_KEYS.botCooldownSeconds,
      DEFAULT_BOT_COOLDOWN_SECONDS,
    )
    const plan = planGroupRoute({
      message,
      conversation,
      bots,
      recent,
      now: env.now(),
      lastSpokeAt: (botId) => this.spokeAt.get(`${botId}:${conversation.id}`) ?? null,
      cooldownMs: Math.max(0, cooldownSeconds) * 1000,
    })
    const wake = (botId: string) =>
      this.ctx.scheduler.enqueue(
        message.authorType === 'bot'
          ? { botId, conversationId: conversation.id, trigger: 'group_message' }
          : userTurn(botId, conversation.id),
      )
    plan.enqueue.forEach(wake)
    if (plan.skipped)
      env.log('info', 'group message not routed', { conversationId: conversation.id, reason: plan.skipped })
    const candidates = plan.triage.flatMap((id) => bots.get(id) ?? [])
    if (candidates.length === 0 || !this.ctx.running()) return
    const chosen = await this.triage(conversation, message, candidates, bots, recent)
    env.log('info', 'group triage', {
      conversationId: conversation.id,
      messageId: message.id,
      candidates: candidates.map((b) => b.slug),
      respond: chosen.map((id) => bots.get(id)?.slug ?? id),
    })
    if (this.ctx.running()) chosen.forEach(wake)
  }

  /** Cheap one-shot call choosing which `candidates` answer; falls back to one bot for user messages. */
  private async triage(
    conversation: ConversationSummary,
    message: Message,
    candidates: Bot[],
    bots: Map<string, Bot>,
    recent: Message[],
  ): Promise<string[]> {
    const env = this.ctx.env()
    const first = candidates[0] as Bot
    const fallback = message.authorType === 'user' ? [(firstBot(candidates) ?? first).id] : []
    const resolved = await env.resolveTriageModel(candidates)
    if (resolved.kind === 'unavailable') return fallback
    const prompt = buildTriagePrompt({ conversation, candidates, bots, recent, message })
    const signal = this.ctx.background()
    try {
      const { text } = await oneShot(env, this.ctx.cli, {
        bot: first,
        resolved: isCliModel(resolved)
          ? { ...resolved, model: resolved.model ?? CLI_ENGINE_DRIVERS[resolved.engine].lightModel }
          : resolved,
        record: { botId: null, conversationId: conversation.id, purpose: 'triage' },
        system: TRIAGE_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: 200,
        estimate: oneShotEstimate(TRIAGE_SYSTEM_PROMPT, { tail: prompt }),
        signal,
      })
      return parseTriageResponse(text, candidates) ?? fallback
    } catch (err) {
      if (signal.aborted) return []
      env.log('warn', 'group triage failed', { conversationId: conversation.id, err: (err as Error).message })
      return fallback
    }
  }
}
