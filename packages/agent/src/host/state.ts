import type { ActivityStep, BotStatus } from '@milibot/shared'

import type { TurnRequest } from '../environment'
import type { LaneInfo, LaneKey } from './lanes'
import type { TextStream } from './turn/text-stream'
import type { LoadedInstructionFile } from '../prompts/repo-instructions'

export const HISTORY_MESSAGES = 60

export class StoppedError extends Error {
  constructor() {
    super('turn stopped')
  }
}

export function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || err instanceof StoppedError || (err as Error)?.name === 'AbortError'
}

export interface TurnState {
  id: string
  botId: string
  startedAt: number
  laneKey: LaneKey
  conversationId: string
  abort: AbortController
  activityMessageId: string | null
  steps: ActivityStep[]
  consecutiveErrors: number
  /** Last LLM call id, linked from the tool calls it produced. */
  llmCallId: string | null
  chain: string[]
  hops: number
  /** An error card was posted (no model, provider or CLI failure). */
  failed?: boolean
  /** Text being streamed into the chat; it becomes a note if a tool call follows it. */
  text: TextStream | null
  /** Last finished text of the turn still shown in the chat, not yet known to be the reply. */
  lastText: { messageId: string; text: string } | null
  /** Text of the last folded note, to recognize the same text arriving again (CLI engines). */
  lastFolded: string | null
  /** A helper's turn: its text goes here (the last one is its report), nothing is posted in the chat. */
  capture: ((text: string) => void) | null
  /** Helpers this chat turn started (a session counts its own across its turns). */
  helpersStarted: number
  /** A chat or session turn still running: user messages in its conversation join it instead of queueing. */
  joinable: boolean
  /** A user message joined the turn and it has not read it yet. */
  incoming: boolean
  /** Hands `incoming` messages to the running CLI process at once (native turns read them per step). */
  deliver: (() => void) | null
  /** Tools sent to the model this turn (native providers only); a call to any other one is refused. */
  offeredTools?: ReadonlySet<string>
  /** Repository instruction files Milibot's tool results brought in this turn, by path (CLI turns' record). */
  instructionFiles?: Map<string, LoadedInstructionFile>
}

/** One lane of a bot (see `lanes.ts`): its queue and running turn. */
export interface LaneState {
  info: LaneInfo
  queue: TurnRequest[]
  running: boolean
  current: TurnState | null
  /** The user stopped the lane and no turn started since: late tool calls (CLI engines via MCP) are refused. */
  stopped: boolean
  /** Tool calls of the running turn waiting without its parallel slot (see `detached`). */
  detached: number
  status: BotStatus
  detail?: string
  targetBotId?: string
}

export interface BotState {
  lanes: Map<LaneKey, LaneState>
  /** No tool runs and no turn starts in any lane (the user paused the bot or has its screen). */
  paused: boolean
  /** The user paused the bot; kept across runtime restarts. */
  userPaused: boolean
  takenOver: boolean
  /** After the user used the screen, GUI actions are refused until the bot takes a screenshot. */
  needsScreenshot: boolean
  pendingNote: boolean
  waiters: Array<() => void>
  /** Status last reported for the bot (the aggregate of its lanes) and the lane it came from. */
  status: BotStatus
  statusLane: LaneKey
  /** Lane whose turn uses the display and Chrome (computer/browser tools), and lanes waiting for it. */
  screen: { holder: LaneKey | null; waiters: Array<() => void> }
}
