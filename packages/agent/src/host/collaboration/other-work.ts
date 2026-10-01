import { clipLine } from '@milibot/shared'

import type { ToolResult } from '../../environment'
import { otherWorkNote, setAsideDoneNote } from '../../prompts/notes'
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

/** A request of a chat set aside (`after_current_work`) until the bot's other lanes busy at the time are free. */
interface SetAside {
  botId: string
  conversationId: string
  task: string
  /** Lanes still busy with the work it waits for, and how that work was described when it was set aside. */
  waitingOn: Map<LaneKey, string>
  finished: string[]
}

/** In memory only: a runtime restart loses what was set aside. */
class SetAsideRequests {
  private readonly byConversation = new Map<string, SetAside>()

  private key(botId: string, conversationId: string): string {
    return `${botId}:${conversationId}`
  }

  get(botId: string, conversationId: string): SetAside | null {
    return this.byConversation.get(this.key(botId, conversationId)) ?? null
  }

  set(entry: SetAside): void {
    this.byConversation.set(this.key(entry.botId, entry.conversationId), entry)
  }

  drop(botId: string, conversationId: string): boolean {
    return this.byConversation.delete(this.key(botId, conversationId))
  }

  dropBot(botId: string): void {
    for (const entry of [...this.byConversation.values()])
      if (entry.botId === botId) this.drop(botId, entry.conversationId)
  }

  /** `lane` has no running or queued turn left: returns the entries that no longer wait for anything. */
  laneFreed(botId: string, lane: LaneKey): SetAside[] {
    const ready: SetAside[] = []
    for (const entry of [...this.byConversation.values()]) {
      if (entry.botId !== botId) continue
      const label = entry.waitingOn.get(lane)
      if (label === undefined) continue
      entry.waitingOn.delete(lane)
      entry.finished.push(label)
      if (entry.waitingOn.size > 0) continue
      this.drop(botId, entry.conversationId)
      ready.push(entry)
    }
    return ready
  }
}

/** The bot's work in its other lanes, as its chat turns see it, and what the chat set aside until it ends. */
export class OtherWork {
  private readonly setAside = new SetAsideRequests()

  constructor(private readonly ctx: HostContext) {}

  dropBot(botId: string): void {
    this.setAside.dropBot(botId)
  }

  /** The bot's lanes other than `laneKey` (helpers aside) with a running or queued turn, described for the bot. */
  private busyLanes(botId: string, laneKey: LaneKey): BusyLane[] {
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
        const conversationId = lane.current?.conversationId ?? lane.queue[0]?.conversationId
        const title = conversationId ? env.getConversation(conversationId)?.title : null
        const label = title ? `your work session "${title}"` : 'one of your work sessions'
        busy.push({ lane, label, line: `${label} (${since})` })
      } else {
        busy.push({ lane, label: 'your chat with the user', line: `your chat with the user (${since})` })
      }
    }
    return busy
  }

  /** Note for the chat and internal lanes while the bot has work running elsewhere; null otherwise. */
  note(botId: string, laneKey: LaneKey, conversationId: string): string | null {
    const kind = laneInfo(laneKey).kind
    if (kind !== 'main' && kind !== 'internal') return null
    const busy = this.busyLanes(botId, laneKey)
    if (busy.length === 0) return null
    return otherWorkNote(
      busy.map((b) => b.line),
      this.setAside.get(botId, conversationId)?.task ?? null,
      kind === 'main',
    )
  }

  /** after_current_work: keeps the task until the lanes busy now are free, then wakes this conversation. */
  afterCurrentWork({ bot, lane, conversationId, call }: HostToolCall): ToolResult {
    if (!conversationId) return toolError(setAsideReplies.noConversation)
    const a = argsObject(call.arguments)
    if (a.cancel === true)
      return this.setAside.drop(bot.id, conversationId)
        ? toolText(setAsideReplies.dropped)
        : toolText(setAsideReplies.nothingToDrop)
    const task = trimmedString(a.task).trim()
    if (!task) return toolError(setAsideReplies.missingTask)
    const waitingOn = new Map<LaneKey, string>()
    for (const busy of this.busyLanes(bot.id, lane.info.key))
      if (busy.lane.info.kind !== 'main' && !waitingOn.has(busy.lane.info.key))
        waitingOn.set(busy.lane.info.key, busy.label)
    if (waitingOn.size === 0) return toolError(setAsideReplies.nothingRunning)
    this.setAside.set({ botId: bot.id, conversationId, task, waitingOn, finished: [] })
    return toolText(setAsideReplies.setAside([...waitingOn.values()]))
  }

  /** `lane` has no running or queued turn left: wakes the chats whose set-aside work waited only for it. */
  laneFreed(lane: LaneState): void {
    for (const entry of this.setAside.laneFreed(lane.info.botId, lane.info.key))
      this.ctx.scheduler.enqueue({
        botId: entry.botId,
        conversationId: entry.conversationId,
        trigger: 'after_current_work',
        laneKey: entry.botId,
        note: setAsideDoneNote(entry.task, entry.finished),
      })
  }
}
