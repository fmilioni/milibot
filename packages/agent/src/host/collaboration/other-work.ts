import { type Bot, clipLine, firstBot, SET_ASIDE_MAX_WAKES } from '@milibot/shared'

import type { SetAsideEntry, ToolResult } from '../../environment'
import { localStamp } from '../../memory/compaction'
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
  idleSince: number | null
}

const sessionLabel = (session: OpenSession) => `your work session "${session.title}"`

/** The label with how long the session has waited: a forgotten one stands out. */
function idleSessionLine(session: OpenSession, now: number): string {
  if (session.idleSince === null) return `${sessionLabel(session)} (no turn running)`
  const stamp = localStamp(session.idleSince)
  const since = stamp.slice(0, 10) === localStamp(now).slice(0, 10) ? stamp.slice(11) : stamp
  return `${sessionLabel(session)} (idle since ${since}, no turn running)`
}

/** How long a bot whose wake did not run (an error, a usage limit, a stop) waits before the next one. */
const RETRY_WAKE_MS = 5 * 60_000

/** Alert turns of the idle watch that did not run before the user is told instead of the watch's bot. */
const MAX_ALERT_TURNS = 3

/**
 * The bot's work as every chat turn sees it (its lanes, open sessions and plans, whichever conversation they
 * started in) and the requests it set aside until that work ends (`after_current_work`, kept by
 * `env.setAside` across restarts). A bot that is free with a request set aside is woken with the oldest one;
 * the request leaves the waiting list only once that turn ran, and after `SET_ASIDE_MAX_WAKES` wakes that did
 * not it stays there for the bot (and the idle watch) instead of being retried. A wake turn that started
 * acting (its first tool call) and then did not end well (an error, a stop, a restart) is never retried
 * either: part of the work may be done, so the request stays there for the bot to finish or cancel. A bot left stopped with
 * requests past the idle watch's limit is reported to the bot the watch reports to; those requests count as
 * reported only once that bot's turn ran (or acted), so an alert lost to a failed turn or a restart is sent again.
 */
export class OtherWork {
  /** Bot id → when one of its turns last ended (the idle watch's clock; the host's start before any). */
  private readonly lastTurnEnded = new Map<string, number>()
  private startedAt = 0
  /** Bot id → the request whose wake turn is queued or running. */
  private readonly waking = new Map<string, string>()
  /** Bot id → when it may be woken again after a wake that did not run. */
  private readonly retryAt = new Map<string, number>()
  /** Stopped bot id → its idle watch alert turn is queued or running. */
  private readonly alerting = new Set<string>()
  /** Stopped bot id → alert turns about it that did not run, in a row. */
  private readonly failedAlerts = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly ctx: HostContext) {}

  /** Wakes the bots left free with requests set aside before a restart, then checks every `intervalMs`. */
  start(intervalMs: number): void {
    this.stop()
    this.startedAt = this.ctx.env().now()
    this.lastTurnEnded.clear()
    this.waking.clear()
    this.retryAt.clear()
    this.alerting.clear()
    this.failedAlerts.clear()
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
    this.waking.delete(botId)
    this.retryAt.delete(botId)
    this.alerting.delete(botId)
    this.failedAlerts.delete(botId)
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
      .map((s) => ({ conversationId: s.conversationId, title: s.title, idleSince: s.idleSince ?? null }))
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
      openSessions: this.openSessions(botId).map((s) => idleSessionLine(s, now)),
      plans: env.workState(botId).plans.map((p) => `"${p.title}" (${p.status.replace('_', ' ')})`),
      // The request this turn may be the wake of is not set aside anymore as far as the bot is concerned.
      setAside: env.setAside
        .waiting(botId)
        .filter((e) => e.id !== this.waking.get(botId))
        .map((e) => this.setAsideLine(e, conversationId, now)),
    })
  }

  private setAsideLine(entry: SetAsideEntry, conversationId: string | null, now: number): string {
    const line =
      `"${clipLine(entry.task, 200)}" (id ${entry.id}, in ${this.whereSetAside(entry, conversationId)}, ` +
      `${Math.max(0, Math.round((now - entry.createdAt) / 60_000))} min ago)`
    if (entry.actedAt !== null)
      return `${line}: the turn that took it up stopped midway (an error, a stop or a restart), so it is no longer woken; check what was already done, then finish it or cancel it`
    return entry.attempts >= SET_ASIDE_MAX_WAKES
      ? `${line}: woken ${entry.attempts} times without the turn running, so no longer woken; take it up or cancel it`
      : line
  }

  /** after_current_work: keeps the task until the bot is free, then wakes this conversation with it. */
  afterCurrentWork({ bot, lane, conversationId, call }: HostToolCall): ToolResult {
    if (!conversationId) return toolError(setAsideReplies.noConversation)
    const env = this.ctx.env()
    const a = argsObject(call.arguments)
    if (a.cancel === true) {
      const id = trimmedString(a.id)
      const dropped = env.setAside.drop(bot.id, id ? { id } : { conversationId })
      if (dropped.length === 0)
        return id ? toolError(setAsideReplies.noSuchRequest(id)) : toolText(setAsideReplies.nothingToDrop)
      return toolText(setAsideReplies.dropped(dropped.map((e) => `"${clipLine(e.task, 200)}"`)))
    }
    const task = trimmedString(a.task)
    if (!task) return toolError(setAsideReplies.missingTask)
    const waitingOn = new Set<string>()
    for (const busy of this.busyLanes(bot.id, lane.info.key)) waitingOn.add(busy.label)
    for (const session of this.openSessions(bot.id)) waitingOn.add(sessionLabel(session))
    if (waitingOn.size === 0) return toolError(setAsideReplies.nothingRunning)
    const now = env.now()
    const others = env.setAside.waiting(bot.id).map((e) => this.setAsideLine(e, conversationId, now))
    env.setAside.add({ botId: bot.id, conversationId, task, waitingOn: [...waitingOn] })
    return toolText(setAsideReplies.setAside([...waitingOn], others))
  }

  /** A lane of the bot closed (a work session stopped or finished with no turn running): it may be free. */
  laneClosed(botId: string): void {
    this.wake(botId)
  }

  /** A turn of `lane` ended: the bot may be free now. */
  turnEnded(lane: LaneState): void {
    if (lane.info.kind === 'subagent') return
    this.lastTurnEnded.set(lane.info.botId, this.ctx.env().now())
    this.wake(lane.info.botId)
  }

  /**
   * A free bot with requests set aside is woken with the oldest, in the conversation that set it aside. The
   * request stays waiting until the bot worked on it in that turn (`woke`): a restart before it runs, or a
   * turn the model could not answer before any tool call, wakes the bot again later. Once the turn acted it
   * is marked in the store at once, so neither a failure nor a restart after that wakes the bot with it again.
   */
  private wake(botId: string): void {
    if (!this.ctx.running() || this.waking.has(botId)) return
    const env = this.ctx.env()
    if (!env.getBot(botId) || this.ctx.lanes.find(botId)?.paused || !this.isFree(botId)) return
    if ((this.retryAt.get(botId) ?? 0) > env.now()) return
    for (const entry of env.setAside.waiting(botId)) {
      if (entry.attempts >= SET_ASIDE_MAX_WAKES || entry.actedAt !== null) continue
      if (!env.getConversation(entry.conversationId)) {
        env.setAside.drop(botId, { id: entry.id })
        continue
      }
      env.setAside.markAttempt(entry.id)
      this.waking.set(botId, entry.id)
      let acted = false
      this.ctx.scheduler.enqueue({
        botId,
        conversationId: entry.conversationId,
        trigger: 'after_current_work',
        note: setAsideDoneNote(entry.task, entry.waitingOn),
        onActing: () => {
          acted = true
          env.setAside.markActed(entry.id)
        },
        onFinished: (outcome, failed) => this.woke(entry, outcome !== 'cancelled' && !failed, acted),
      })
      return
    }
  }

  /**
   * `ran`: the bot worked on it (even if a tool of that turn failed). A turn that acted and then failed or
   * was stopped leaves it waiting, marked as acted (never woken again); one that failed before acting is
   * woken again later.
   */
  private woke(entry: SetAsideEntry, ran: boolean, acted: boolean): void {
    if (this.waking.get(entry.botId) === entry.id) this.waking.delete(entry.botId)
    const env = this.ctx.env()
    if (ran) {
      this.retryAt.delete(entry.botId)
      env.setAside.markWoken(entry.id)
    } else if (!acted) {
      this.retryAt.set(entry.botId, env.now() + RETRY_WAKE_MS)
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
   * The requests are marked as reported only once that turn acted or ran: a turn that fails first, or a restart
   * before it runs, leaves them unreported and the next check sends the alert again (to the user after
   * `MAX_ALERT_TURNS` turns that did not run, so a watcher that cannot answer is not woken forever).
   */
  private watch(botId: string, entries: SetAsideEntry[]): void {
    const minutes = this.ctx.settings.idleWatchMinutes()
    if (this.alerting.has(botId)) return
    if (minutes <= 0 || this.ctx.lanes.find(botId)?.paused || this.busyLanes(botId, null).length) return
    const fresh = entries.filter((e) => e.alertedAt === null)
    const oldest = fresh[0]
    if (!oldest) return
    const env = this.ctx.env()
    const idleSince = Math.max(this.lastTurnEnded.get(botId) ?? this.startedAt, oldest.createdAt)
    const idleFor = env.now() - idleSince
    if (idleFor < minutes * 60_000) return
    const bot = env.getBot(botId)
    if (!bot) return
    const watcher = (this.failedAlerts.get(botId) ?? 0) >= MAX_ALERT_TURNS ? 'user' : this.watcher(botId)
    if (watcher === 'user') {
      this.tellUser(bot, Math.round(idleFor / 60_000), entries, fresh)
      return
    }
    const ids = fresh.map((e) => e.id)
    let alerted = false
    const markAlerted = () => {
      if (alerted) return
      alerted = true
      env.setAside.markAlerted(ids)
    }
    this.alerting.add(botId)
    // In the watcher's chat with the user, so the bot's answer to its message_bot comes back to it there.
    const conversation = env.findDirectConversation(watcher.id) ?? env.internalConversation(watcher.id, botId)
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
      onActing: markAlerted,
      onFinished: (outcome, failed) => {
        this.alerting.delete(botId)
        if (outcome !== 'cancelled' && !failed) markAlerted()
        if (alerted) this.failedAlerts.delete(botId)
        else this.failedAlerts.set(botId, (this.failedAlerts.get(botId) ?? 0) + 1)
      },
    })
  }

  /**
   * Who is told `botId` is stopped: the chosen bot while it exists, else the first bot. When that is `botId`
   * itself, the fallback the user picked: the next bot of the team, or the user (also with no other bot).
   */
  private watcher(botId: string): Bot | 'user' {
    const env = this.ctx.env()
    const bots = env.listBots()
    const chosen = this.ctx.settings.idleWatchBotId()
    const watcher = (chosen ? env.getBot(chosen) : null) ?? firstBot(bots)
    if (watcher && watcher.id !== botId) return watcher
    if (this.ctx.settings.idleWatchFallback() === 'user') return 'user'
    return nextBot(bots, botId) ?? 'user'
  }

  /** A line in the stopped bot's chat with the user, which the app also raises as a notification. */
  private tellUser(bot: Bot, minutes: number, entries: SetAsideEntry[], fresh: SetAsideEntry[]): void {
    const env = this.ctx.env()
    const conversation = env.findDirectConversation(bot.id)
    if (!conversation) return
    env.setAside.markAlerted(fresh.map((e) => e.id))
    this.failedAlerts.delete(bot.id)
    const tasks = entries.map((e) => clipLine(e.task, 200))
    env.appendMessage({
      conversationId: conversation.id,
      authorType: 'system',
      kind: 'system_event',
      content: `${bot.name} has done nothing for ${minutes} min while it has requests set aside: ${tasks.join('; ')}`,
      payload: {
        type: 'system',
        event: 'idle_watch_alert',
        botId: bot.id,
        params: { minutes, tasks: tasks.join('; ') },
      },
    })
  }
}

/** The bot after `botId` in the team's order (oldest first), wrapping around; never `botId` itself. */
function nextBot(bots: Bot[], botId: string): Bot | undefined {
  const order: Bot[] = []
  const rest = [...bots]
  for (let bot = firstBot(rest); bot; bot = firstBot(rest)) {
    order.push(bot)
    rest.splice(rest.indexOf(bot), 1)
  }
  const at = order.findIndex((b) => b.id === botId)
  const next = order[(at + 1) % order.length]
  return next && next.id !== botId ? next : undefined
}
