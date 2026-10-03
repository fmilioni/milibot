import type { Bot, CliEngine } from '@milibot/shared'

import type { CliSessions } from '../cli/engine'
import type { AgentEnvironment } from '../environment'
import type { MemoryConfig } from '../memory/types'
import type { BotMessaging } from './collaboration/bot-messaging'
import type { GroupRouting } from './collaboration/group-routing'
import type { OtherWork } from './collaboration/other-work'
import type { HostKnowledge } from './knowledge'
import type { HostMemory } from './memory'
import type { ReadTracker } from './read-tracking'
import type { BotControl } from './scheduling/control'
import type { LaneRegistry } from './scheduling/lane-registry'
import type { Scheduler } from './scheduling/scheduler'
import type { ScreenLock } from './scheduling/screen-lock'
import type { AgentSettings } from './settings'
import type { Subagents } from './subagents'
import type { ToolRunner } from './tools/tool-runner'
import type { TurnActivity } from './turn/activity'
import type { TurnRunner } from './turn/run-turn'
import type { TurnInput } from './turn/turn-input'
import type { SessionContext } from './work-sessions/session-context'

export interface HostOptions {
  /** Max LLM calls in one turn before the loop gives up. */
  maxSteps: number
  /** Same, for turns in a work session's lanes (long tasks). */
  sessionMaxSteps: number
  /** Memory budgets before the workspace settings (which still apply on top of the tail budget). */
  memory: MemoryConfig
  deltaFlushMs: number
  /** Run the post-turn compaction. */
  compaction: boolean
  /** How long a lane waits for the bot's screen held by another lane before the tool call is refused. */
  screenWaitSeconds: number
  /** Helpers one work session (or one chat turn) may start. */
  maxSubagents: number
  /** How often free bots with requests set aside are woken and the idle watch runs. */
  idleWatchIntervalMs: number
}

/** Each CLI engine's processes (engines whose backend the environment has: none without a VM). */
export type CliEngines = ReadonlyMap<CliEngine, CliSessions>

/**
 * What the host's collaborators share. Collaborators reach each other through it only inside their methods
 * (never while being built), so the host can wire them in any order.
 */
export interface HostContext {
  /** Throws until the host starts. */
  env(): AgentEnvironment
  /** False once the host stopped: nothing new is queued, routed or compacted. */
  running(): boolean
  /** Aborted when the host stops: background work (group triage, compaction). */
  background(): AbortSignal
  botsById(): Map<string, Bot>
  readonly options: HostOptions
  readonly settings: AgentSettings
  readonly cli: CliEngines
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
}
