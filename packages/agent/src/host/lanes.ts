import type { BotStatus } from '@milibot/shared'

/**
 * A bot works in lanes, each with its own queue, running turn and CLI process: the main lane
 * (chat, DMs, groups, routines), the internal lane (requests from other bots), one lane per work session and
 * the helper (subagent) lanes of the chat and of sessions. The main lane's key is the bot id.
 */
export type LaneKey = string
export type LaneKind = 'main' | 'internal' | 'session' | 'subagent'

export interface LaneInfo {
  key: LaneKey
  botId: string
  kind: LaneKind
  sessionId: string | null
  parentKey: LaneKey | null
}

export function sessionLaneKey(botId: string, sessionId: string): LaneKey {
  return `${botId}:${sessionId}`
}

/** Stands for the chat in the key of a helper the main lane started (session ids never take this form). */
const CHAT_HELPERS = 'chat'

/** Session ids never take this form either. */
const INTERNAL = 'internal'

export function internalLaneKey(botId: string): LaneKey {
  return `${botId}:${INTERNAL}`
}

/** A helper's lane: of a work session, or of the chat (`sessionId` null). */
export function subagentLaneKey(botId: string, sessionId: string | null, index: number): LaneKey {
  return `${botId}:${sessionId ?? CHAT_HELPERS}:sub:${index}`
}

export function laneInfo(key: LaneKey): LaneInfo {
  const [botId = key, sessionId, marker, index] = key.split(':')
  if (!sessionId) return { key, botId, kind: 'main', sessionId: null, parentKey: null }
  if (marker === undefined && sessionId === INTERNAL)
    return { key, botId, kind: 'internal', sessionId: null, parentKey: botId }
  if (marker === 'sub' && index !== undefined) {
    if (sessionId === CHAT_HELPERS) return { key, botId, kind: 'subagent', sessionId: null, parentKey: botId }
    return { key, botId, kind: 'subagent', sessionId, parentKey: sessionLaneKey(botId, sessionId) }
  }
  return { key, botId, kind: 'session', sessionId, parentKey: botId }
}

export function isBotLane(key: LaneKey, botId: string): boolean {
  return key === botId || key.startsWith(`${botId}:`)
}

/** Tools that drive the bot's display or its Chrome, shared by all of the bot's lanes. */
export function isScreenTool(name: string): boolean {
  return name === 'computer' || name.startsWith('browser_')
}

const STATUS_RANK: Record<BotStatus, number> = {
  idle: 0,
  paused: 1,
  thinking: 2,
  talking: 3,
  effort: 4,
  working: 5,
}

/** The busiest of two statuses (the bot shows the busiest of its non-main lanes). */
export function busier(a: BotStatus, b: BotStatus): boolean {
  return STATUS_RANK[a] > STATUS_RANK[b]
}
