import { clipLine, firstBot } from '@milibot/shared'

import type { SetAsideEntry, ToolResult } from '../../environment'
import { botStateNote, idleWatchNote, setAsideDoneNote } from '../../prompts/notes'
import { setAsideReplies } from '../../prompts/tool-replies'
import { argsObject, trimmedString } from '../../tools/args'
import { toolError, toolText } from '../../tools/result'
import type { HostContext } from '../context'
import { laneInfo, type LaneKey } from '../lanes'
import type { LaneState } from '../state'
import type { HostToolCall } from '../tools/host-tools'

interface BusyLane {
  lane: LaneState
  label: string
  line: string
}

/** A work session not ended whose lane has no turn running or queued. */
interface OpenSession {
  conversationId: string
  title: string
}

const sessionLabel = (session: OpenSession) => `your work session "${session.title}"`

/**
 * The bot's work as every chat turn sees it (its lanes, open sessions and plans, whichever conversation they
 * started in) and the requests it set aside until that work ends (`after_current_work`, kept by
 * `env.setAside` across restarts). A bot that is free with a request set aside is woken with the oldest one;
 * one left stopped with requests past the idle watch's limit is reported to the bot the watch reports to.
 */
export class OtherWork {
  /** Bot id → when one of its turns last ended (the idle watch's clock; the host's start before any). */
  private readonly lastTurnEnded = new Map<string, number>()
  private startedAt = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly ctx: HostContext) {}

  /** Wakes the bots left free with requests set aside before a restart, then checks every `intervalMs`. */
  start(intervalMs: number): void {
    this.stop()
    this.startedAt = this.ctx.env().now()
    this.lastTurnEnded.clear()
    this.timer = setInterval(() => this.tick(), intervalMs)
    this.timer.unref?.()
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The bot was stopped or deleted: what it set aside goes too. */
  dropBot(botId: string): void {
    this.ctx.env().setAside.drop(botId)
    this.lastTurnEnded.delete(botId)
  }

  /** The bot's lanes other than `laneKey` (helpers aside) with a running or queued turn, described for the bot. */
  private busyLanes(botId: string, laneKey: LaneKey | null): BusyLane[] {
    const state = this.ctx.lanes.find(botId)
    if (!state) return []
    const env = this.ctx.env()
    const busy: BusyLane[] = []
    for (const lane of state.lanes.values()) {
      if (lane.info.key === laneKey || lane.info.kind === 'subagent') continue
      if (!lane.running && lane.queue.length === 0) continue
      const since = lane.current
        ? `running for ${Math.max(1, Math.round((env.now() - lane.current.startedAt) / 60_000))} min`
        : 'waiting to start'
      if (lane.info.kind === 'internal') {
        const asked = this.ctx.messaging.requestsTo(botId)
        if (asked.length === 0)
          busy.push({
            lane,
            label: 'a request from another bot',
            line: `a request from another bot (${since})`,
          })
        for (const request of asked) {
          const from = env.getBot(request.fromBotId)?.name ?? 'another bot'
          const label = `a request from ${from}`
          busy.push({ lane, label, line: `${label} (${since}): "${clipLine(request.card.preview, 160)}"` })
        }
      } else if (lane.info.kind === 'session') {
        const title = env.getConversation(this.sessionConversation(lane) ?? '')?.title
        const label = title ? `your work session "${title}"` : 'one of your work sessions'
        busy.push({ lane, label, line: `${label} (${since})` })
      } else {
        busy.push({ lane, label: 'your chat with the user', line: `your chat with the user (${since})` })
      }
    }
    return busy
  }

  private sessionConversation(lane: LaneState): string | null {
    return lane.current?.conversationId ?? lane.queue[0]?.conversationId ?? null
  }

  /** Sessions of the bot not ended whose lane is not busy (a busy one is among `busyLanes`). */
  private openSessions(botId: string): OpenSession[] {
    const state = this.ctx.lanes.find(botId)
    const working = new Set<string>()
    for (const lane of state?.lanes.values() ?? []) {
      if (lane.info.kind !== 'session' || (!lane.running && lane.queue.length === 0)) continue
      const conversationId = this.sessionConversation(lane)
      if (conversationId) working.add(conversationId)
    }
    return this.ctx
      .env()
      .workState(botId)
      .sessions.filter((s) => !working.has(s.conversationId))
      .map((s) => ({ conversationId: s.conversationId, title: s.title }))
  }

  /** Nothing of the bot runs or waits to run and none of its sessions is open. */
  private isFree(botId: string): boolean {
    return this.busyLanes(botId, null).length === 0 && this.openSessions(botId).length === 0
  }

  private whereSetAside(entry: SetAsideEntry, conversationId: string | null): string {
    if (entry.conversationId === conversationId) return 'this conversation'
    const env = this.ctx.env()
    const conversation = env.getConversation(entry.conversationId)
    if (!conversation) return 'a conversation'
    if (conversation.type === 'direct') return 'your chat with the user'
    if (conversation.type === 'internal') {
      const other = conversation.memberBotIds.find((id) => id !== entry.botId)
      return `your conversation with ${(other && env.getBot(other)?.name) ?? 'another bot'}`
    }
    return conversation.title ? `"${conversation.title}"` : 'a group chat'
  }

  /** Note for the chat and internal lanes: the bot's state across all its conversations. */
  note(botId: string, laneKey: LaneKey, conversationId: string): string | null {
    const kind = laneInfo(laneKey).kind
    if (kind !== 'main' && kind !== 'internal') return null
    const env = this.ctx.env()
    const now = env.now()
    return botStateNote({
      running: this.busyLanes(botId, laneKey).map((b) => b.line),
      openSessions: this.openSessions(botId).map(sessionLabel),
      plans: env.workState(botId).plans.map((p) => `"${p.title}" (${p.status.replace('_', ' ')})`),
      setAside: env.setAside
        .waiting(botId)
        .map(
          (e) =>
            `"${clipLine(e.task, 200)}" (in ${this.whereSetAside(e, conversationId)}, ` +
            `${Math.max(0, Math.round((now - e.createdAt) / 60_000))} min ago)`,
        ),
    })
  }

  /** after_current_work: keeps the task until the bot is free, then wakes this conversation with it. */
  afterCurrentWork({ bot, lane, conversationId, call }: HostToolCall): ToolResult {
    if (!conversationId) return toolError(setAsideReplies.noConversation)
    const env = this.ctx.env()
    const a = argsObject(call.arguments)
    if (a.cancel === true) {
      const dropped = env.setAside.drop(bot.id, conversationId)
      return toolText(dropped ? setAsideReplies.dropped(dropped) : setAsideReplies.nothingToDrop)
    }
    const task = trimmedString(a.task).trim()
    if (!task) return toolError(setAsideReplies.missingTask)
    const waitingOn = new Set<string>()
    for (const busy of this.busyLanes(bot.id, lane.info.key)) waitingOn.add(busy.label)
    for (const session of this.openSessions(bot.id)) waitingOn.add(sessionLabel(session))
    if (waitingOn.size === 0) return toolError(setAsideReplies.nothingRunning)
    env.setAside.add({ botId: bot.id, conversationId, task, waitingOn: [...waitingOn] })
    return toolText(setAsideReplies.setAside([...waitingOn]))
  }

  /** A turn of `lane` ended: the bot may be free now. */
  turnEnded(lane: LaneState): void {
    if (lane.info.kind === 'subagent') return
    this.lastTurnEnded.set(lane.info.botId, this.ctx.env().now())
    this.wake(lane.info.botId)
  }

  /** A free bot with requests set aside is woken with the oldest, in the conversation that set it aside. */
  private wake(botId: string): void {
    if (!this.ctx.running()) return
    const env = this.ctx.env()
    if (!env.getBot(botId) || this.ctx.lanes.find(botId)?.paused || !this.isFree(botId)) return
    for (const entry of env.setAside.waiting(botId)) {
      env.setAside.markWoken(entry.id)
      if (!env.getConversation(entry.conversationId)) continue
      this.ctx.scheduler.enqueue({
        botId,
        conversationId: entry.conversationId,
        trigger: 'after_current_work',
        note: setAsideDoneNote(entry.task, entry.waitingOn),
      })
      return
    }
  }

  /** Wakes the free bots with requests set aside and runs the idle watch. */
  tick(): void {
    if (!this.ctx.running()) return
    const env = this.ctx.env()
    const byBot = new Map<string, SetAsideEntry[]>()
    for (const entry of env.setAside.waiting())
      byBot.set(entry.botId, [...(byBot.get(entry.botId) ?? []), entry])
    for (const [botId, entries] of byBot) {
      if (!env.getBot(botId)) {
        env.setAside.drop(botId)
        continue
      }
      this.wake(botId)
      this.watch(botId, entries)
    }
  }

  /**
   * A bot with nothing running for longer than the limit while it has requests set aside (an open session it
   * never finished, for one) is reported once per request to the watch's bot, in their private conversation.
   */
  private watch(botId: string, entries: SetAsideEntry[]): void {
    const minutes = this.ctx.settings.idleWatchMinutes()
    if (minutes <= 0 || this.ctx.lanes.find(botId)?.paused || this.busyLanes(botId, null).length) return
    const fresh = entries.filter((e) => e.alertedAt === null)
    const oldest = fresh[0]
    if (!oldest) return
    const env = this.ctx.env()
    const idleSince = Math.max(this.lastTurnEnded.get(botId) ?? this.startedAt, oldest.createdAt)
    const idleFor = env.now() - idleSince
    if (idleFor < minutes * 60_000) return
    const bot = env.getBot(botId)
    const watcher = this.watcher()
    if (!bot || !watcher || watcher.id === botId) return
    env.setAside.markAlerted(fresh.map((e) => e.id))
    const conversation = env.internalConversation(watcher.id, botId)
    this.ctx.scheduler.enqueue({
      botId: watcher.id,
      conversationId: conversation.id,
      trigger: 'idle_watch',
      note: idleWatchNote(
        bot.name,
        Math.round(idleFor / 60_000),
        entries.map((e) => `"${clipLine(e.task, 200)}"`),
        this.openSessions(botId).map((s) => `"${s.title}"`),
      ),
    })
  }

  /** The bot the idle watch reports to: the chosen one while it exists, else the first bot. */
  private watcher() {
    const env = this.ctx.env()
    const chosen = this.ctx.settings.idleWatchBotId()
    return (chosen ? env.getBot(chosen) : null) ?? firstBot(env.listBots()) ?? null
  }
}
