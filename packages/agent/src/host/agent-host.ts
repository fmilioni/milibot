import type { Bot, BotControlAction, BotControlOptions, CliEngine, Message } from '@milibot/shared'

import type { GuestCliBackend } from '../cli/backend'
import type { CliSessions } from '../cli/engine'
import { CLI_ENGINE_DRIVERS } from '../cli/registry'
import type {
  AgentEnvironment,
  AgentHost,
  ScreenState,
  ToolResult,
  TurnRequest,
  WriteTextRequest,
} from '../environment'
import type { ToolCall } from '../llm/messages'
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../memory/types'
import { BotMessaging } from './collaboration/bot-messaging'
import { GroupRouting } from './collaboration/group-routing'
import { OtherWork } from './collaboration/other-work'
import type { HostContext, HostOptions } from './context'
import { HostKnowledge } from './knowledge'
import { laneInfo } from './lanes'
import { HostMemory } from './memory'
import { ReadTracker } from './read-tracking'
import { BotControl } from './scheduling/control'
import { LaneRegistry } from './scheduling/lane-registry'
import { Scheduler } from './scheduling/scheduler'
import { ScreenLock } from './scheduling/screen-lock'
import { type AgentSettings, agentSettings } from './settings'
import { Subagents } from './subagents'
import { ToolRunner } from './tools/tool-runner'
import { TurnActivity } from './turn/activity'
import { type OneShotResult, writeText } from './turn/one-shot'
import { TurnRunner } from './turn/run-turn'
import { TurnInput } from './turn/turn-input'
import { SessionContext } from './work-sessions/session-context'

export interface AgentHostOptions {
  /** Max LLM calls in one turn before the loop gives up. */
  maxSteps?: number
  /** Same, for turns in a work session's lanes (long tasks). */
  sessionMaxSteps?: number
  /** Overrides of the memory budgets (workspace settings still apply on top of the tail budget). */
  memory?: Partial<MemoryConfig>
  deltaFlushMs?: number
  /** Run the post-turn compaction (default true). */
  compaction?: boolean
  /** Default 120. */
  screenWaitSeconds?: number
  /** Default 20. */
  maxSubagents?: number
  /** Default one minute. */
  idleWatchIntervalMs?: number
}

/** The host's collaborators, wired together; the environment arrives with `start`. */
class HostServices implements HostContext {
  environment: AgentEnvironment | null = null
  stopped = false
  backgroundAbort = new AbortController()
  readonly cli = new Map<CliEngine, CliSessions>()
  readonly settings: AgentSettings = agentSettings((key, fallback) => this.env().getSetting(key, fallback))
  readonly lanes: LaneRegistry
  readonly scheduler: Scheduler
  readonly control: BotControl
  readonly screen: ScreenLock
  readonly activity: TurnActivity
  readonly reads: ReadTracker
  readonly helpers: Subagents
  readonly messaging: BotMessaging
  readonly routing: GroupRouting
  readonly otherWork: OtherWork
  readonly memory: HostMemory
  readonly knowledge: HostKnowledge
  readonly sessions: SessionContext
  readonly tools: ToolRunner
  readonly inputs: TurnInput
  readonly turns: TurnRunner

  constructor(readonly options: HostOptions) {
    this.lanes = new LaneRegistry(this)
    this.scheduler = new Scheduler(this)
    this.control = new BotControl(this)
    this.screen = new ScreenLock(this)
    this.activity = new TurnActivity(this)
    this.reads = new ReadTracker(this)
    this.helpers = new Subagents(this)
    this.messaging = new BotMessaging(this)
    this.routing = new GroupRouting(this)
    this.otherWork = new OtherWork(this)
    this.memory = new HostMemory(this)
    this.knowledge = new HostKnowledge(this)
    this.sessions = new SessionContext(this)
    this.tools = new ToolRunner(this)
    this.inputs = new TurnInput(this)
    this.turns = new TurnRunner(this)
  }

  env(): AgentEnvironment {
    if (!this.environment) throw new Error('agent host not started')
    return this.environment
  }

  running(): boolean {
    return !this.stopped
  }

  background(): AbortSignal {
    return this.backgroundAbort.signal
  }

  botsById(): Map<string, Bot> {
    return new Map(
      this.env()
        .listBots()
        .map((b) => [b.id, b]),
    )
  }
}

export class DefaultAgentHost implements AgentHost {
  private readonly ctx: HostServices

  constructor(options: AgentHostOptions = {}) {
    this.ctx = new HostServices({
      maxSteps: options.maxSteps ?? 40,
      sessionMaxSteps: options.sessionMaxSteps ?? 200,
      memory: { ...DEFAULT_MEMORY_CONFIG, ...options.memory },
      deltaFlushMs: options.deltaFlushMs ?? 40,
      compaction: options.compaction ?? true,
      screenWaitSeconds: options.screenWaitSeconds ?? 120,
      maxSubagents: options.maxSubagents ?? 20,
      idleWatchIntervalMs: options.idleWatchIntervalMs ?? 60_000,
    })
  }

  async start(env: AgentEnvironment): Promise<void> {
    const ctx = this.ctx
    ctx.environment = env
    ctx.stopped = false
    ctx.backgroundAbort = new AbortController()
    ctx.cli.clear()
    for (const [engine, backend] of Object.entries(env.cli) as Array<[CliEngine, GuestCliBackend]>) {
      const log = (message: string, extra?: Record<string, unknown>) =>
        env.log('warn', message, { engine, ...extra })
      ctx.cli.set(engine, CLI_ENGINE_DRIVERS[engine].createSessions(backend, log))
    }
    ctx.control.restore()
    ctx.otherWork.start(ctx.options.idleWatchIntervalMs)
  }

  async stop(): Promise<void> {
    const ctx = this.ctx
    ctx.stopped = true
    ctx.otherWork.stop()
    for (const [botId, state] of ctx.lanes.botStates()) {
      for (const lane of state.lanes.values()) ctx.scheduler.abortLane(lane)
      ctx.lanes.wake(botId)
    }
    ctx.backgroundAbort.abort()
    await ctx.scheduler.idle()
    await Promise.all([...ctx.cli.values()].map((sessions) => sessions.closeAll()))
  }

  async forgetBot(botId: string): Promise<void> {
    const ctx = this.ctx
    const state = ctx.lanes.find(botId)
    if (state) {
      state.paused = false
      state.takenOver = false
      for (const lane of state.lanes.values()) ctx.scheduler.abortLane(lane)
      ctx.lanes.wake(botId)
    }
    ctx.otherWork.dropBot(botId)
    ctx.messaging.dropBot(botId)
    await ctx.scheduler.idle(botId)
    await Promise.all([...ctx.cli.values()].map((sessions) => sessions.closeBot(botId)))
    ctx.lanes.removeBot(botId)
  }

  async closeLane(laneKey: string): Promise<void> {
    const ctx = this.ctx
    const info = laneInfo(laneKey)
    if (info.kind === 'main') return
    const lane = ctx.lanes.findLane(laneKey)
    if (lane) lane.closed = true
    if (lane && info.kind === 'session') {
      // Requests still queued there go where the ended session started (or are dropped with a deleted one).
      const queued = lane.queue
      lane.queue = []
      for (const request of queued) {
        if (ctx.env().workSession(request.conversationId)?.ended) ctx.scheduler.enqueue(request)
        else request.onFinished?.('cancelled')
      }
    }
    await Promise.all([...ctx.cli.values()].map((sessions) => sessions.close(laneKey)))
    if (lane && !lane.running && lane.queue.length === 0) {
      ctx.screen.release(lane)
      ctx.lanes.removeLane(lane)
    }
    ctx.otherWork.laneClosed(info.botId)
  }

  onMessageCreated(message: Message): void {
    if (this.ctx.stopped || message.authorType !== 'user' || !this.ctx.environment) return
    this.ctx.routing.onUserMessage(message)
  }

  enqueueTurn(request: TurnRequest): void {
    this.ctx.scheduler.enqueue(request)
  }

  hold(held: boolean): void {
    this.ctx.scheduler.hold(held)
  }

  idle(botId?: string): Promise<void> {
    return this.ctx.scheduler.idle(botId)
  }

  control(botId: string, action: BotControlAction, options?: BotControlOptions): ScreenState {
    return this.ctx.control.control(botId, action, options)
  }

  screenState(botId: string): ScreenState {
    return this.ctx.control.screenState(botId)
  }

  isReadOnlyLane(laneKey: string): boolean {
    return this.ctx.helpers.get(laneKey)?.readOnly === true
  }

  laneBusy(laneKey: string): boolean {
    const lane = this.ctx.lanes.findLane(laneKey)
    return !!lane && (lane.running || lane.queue.length > 0)
  }

  runTool(
    botId: string,
    conversationId: string | null,
    call: ToolCall,
    laneKey?: string,
  ): Promise<ToolResult> {
    return this.ctx.tools.runTool(botId, conversationId, call, laneKey)
  }

  writeText(request: WriteTextRequest): Promise<OneShotResult> {
    return writeText(this.ctx.env(), this.ctx.cli, request)
  }

  resumeBotMessage(heldId: string): boolean {
    return this.ctx.messaging.resume(heldId)
  }
}

export function createAgentHost(options?: AgentHostOptions): DefaultAgentHost {
  return new DefaultAgentHost(options)
}
