import type { ContextComposition } from '@milibot/shared'

import { calibrateComposition } from '../memory/tokens'
import type { CliRotationSettings } from './settings'

/** What Milibot knows about a lane's stored CLI session (`cliKeys(engine).meta`). */
export interface CliSessionMeta {
  sessionId: string
  /** Profile hash (`CliEngineDriver.profile`) the session was started with. */
  profile: string
  /** Model requested for the session, null = the CLI's default. */
  model: string | null
  /** End of the last turn. */
  lastUsedAt: number
  /** Prompt tokens of the last request: the size of the session's context. */
  contextTokens: number | null
  /** The CLI's own system prompt + native tools, measured on the first request of the session. */
  baseTokens: number | null
  /** Last project block given to the session (a project's context goes in the input, not the bootstrap). */
  lastProject?: { projectId: string; digest: string } | null
}

export type RotationReason = 'idle' | 'context_size' | 'model_changed' | 'config_changed'

/**
 * Why the bot's stored session should be replaced by a fresh one before the next turn (null = keep
 * it). A session older than the prompt cache would be rewritten in full at the cache-write price
 * (2x input), and a large one is reread on every request, so starting lean with the Milibot memory
 * is cheaper; a session from another profile or model would not reuse the cache either.
 */
export function rotationReason(input: {
  sessionId: string | null
  meta: CliSessionMeta | null
  profile: string
  model: string | null
  now: number
  settings: CliRotationSettings
}): RotationReason | null {
  const { sessionId, meta } = input
  if (!sessionId) return null
  if (!meta || meta.sessionId !== sessionId || meta.profile !== input.profile) return 'config_changed'
  if (meta.model !== input.model) return 'model_changed'
  if (input.now - meta.lastUsedAt > input.settings.rotateIdleMinutes * 60_000) return 'idle'
  if ((meta.contextTokens ?? 0) > input.settings.rotateContextTokens) return 'context_size'
  return null
}

/** Estimated tokens of what one request of the session carries besides its history. */
export interface CliFixedParts {
  /** The CLI's own system prompt + native tools. */
  base: number
  /** Milibot rules and persona (`--append-system-prompt-file`, Codex's developer instructions). */
  persona: number
  /** MCP tool definitions: Milibot's and the enabled external servers'. */
  mcpTools: number
  longTermMemory: number
  summaries: number
  /** Recent messages injected when the session started. */
  recap: number
  /** This turn's input (with the memory note of a resumed session). */
  input: number
}

/**
 * Where the prompt tokens of a CLI turn went. Every request of the turn resends the fixed
 * parts, so they count once per request; what is left of the billed prompt tokens is the session
 * history (earlier turns, and this turn's tool calls and results).
 */
export function cliComposition(
  parts: CliFixedParts,
  requests: number,
  promptTokens: number,
  mcpServers: Record<string, number> = {},
): ContextComposition {
  const n = Math.max(1, requests)
  const fixed: ContextComposition = {
    base: n * parts.base,
    systemPrompt: n * parts.persona,
    tools: n * parts.mcpTools,
    longTermMemory: n * parts.longTermMemory,
    summaries: n * parts.summaries,
    retrieved: 0,
    recentTail: n * (parts.input + parts.recap),
  }
  const fixedTotal = Object.values(fixed).reduce((sum: number, v) => sum + (typeof v === 'number' ? v : 0), 0)
  const servers = Object.keys(mcpServers).length
    ? { mcpServers: Object.fromEntries(Object.entries(mcpServers).map(([k, v]) => [k, n * v])) }
    : {}
  if (promptTokens <= 0) return { ...fixed, ...servers, history: 0 }
  if (fixedTotal <= promptTokens) return { ...fixed, ...servers, history: promptTokens - fixedTotal }
  return { ...calibrateComposition({ ...fixed, ...servers }, promptTokens), history: 0 }
}

/** The CLI's own part of the first request of a fresh session (what Milibot did not send). */
export function measureBaseTokens(
  firstContextTokens: number | null,
  parts: Omit<CliFixedParts, 'base'>,
): number | null {
  if (firstContextTokens === null || firstContextTokens <= 0) return null
  const injected =
    parts.persona + parts.mcpTools + parts.longTermMemory + parts.summaries + parts.recap + parts.input
  const base = firstContextTokens - injected
  return base > 0 ? base : null
}
