import { type DebugTurn, LLM_CALL_RUNNING, type LlmCallRow } from '@milibot/shared'

import { formatDuration, formatUsd } from '@/lib/format'

export function formatCost(value: number | null, locale: string): string {
  return value === null ? '—' : formatUsd(value, locale, 'cost')
}

export function formatLatency(ms: number | null, locale: string): string {
  return ms === null ? '—' : formatDuration(ms, locale)
}

export function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/** "claude-opus-5-5" → "Opus 5.5", "anthropic/claude-sonnet-4.5" → "Sonnet 4.5"; other models as they are. */
export function shortModel(model: string): string {
  const id = model.split('/').pop() ?? model
  const claude =
    /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:[-.](\d{1,2}))?)?(?:-\d{8})?(?:\[.*\])?$/i.exec(id)
  if (!claude) return id
  const family = (claude[1] as string).charAt(0).toUpperCase() + (claude[1] as string).slice(1).toLowerCase()
  const version = claude[2] ? `${claude[2]}${claude[3] ? `.${claude[3]}` : ''}` : ''
  return version ? `${family} ${version}` : family
}

const LIMIT_STOPS = new Set(['max_tokens', 'length', 'max_turns', 'error_max_turns'])

export type CallTone = 'ok' | 'retried' | 'limit' | 'error' | 'running'

export function callTone(call: Pick<LlmCallRow, 'error' | 'stopReason' | 'retries'>): CallTone {
  if (call.error) return 'error'
  if (call.stopReason === LLM_CALL_RUNNING) return 'running'
  if ((call.retries ?? 0) > 0) return 'retried'
  if (call.stopReason && LIMIT_STOPS.has(call.stopReason)) return 'limit'
  return 'ok'
}

export type PurposeBadge = 'triage' | 'summary' | 'intro' | 'procedure' | 'other'

export function purposeBadge(purpose: string): PurposeBadge | null {
  switch (purpose) {
    case 'turn':
      return null
    case 'triage':
    case 'intro':
    case 'procedure':
      return purpose
    case 'summary':
    case 'summary_merge':
      return 'summary'
    default:
      return 'other'
  }
}

export interface TokenBreakdown {
  input: number
  output: number
  cachedRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

export function tokenBreakdown(calls: LlmCallRow[]): TokenBreakdown {
  const sum = (pick: (c: LlmCallRow) => number) => calls.reduce((s, c) => s + pick(c), 0)
  const input = sum((c) => c.inputTokens)
  const output = sum((c) => c.outputTokens)
  const cachedRead = sum((c) => c.cachedReadTokens)
  const cacheWrite = sum((c) => c.cacheWriteTokens)
  const reasoning = sum((c) => c.reasoningTokens)
  return {
    input,
    output,
    cachedRead,
    cacheWrite,
    reasoning,
    total: input + output + cachedRead + cacheWrite + reasoning,
  }
}

/** One row of the "Calls" list: a bot turn (all its LLM calls) or a call outside turns (triage, summary…). */
export interface TurnRow {
  key: string
  turn: DebugTurn | null
  /** Newest first. */
  calls: LlmCallRow[]
  botId: string | null
  /** Set for rows that are not a regular turn (triage, summary, procedure, intro). */
  badge: PurposeBadge | null
  startedAt: number
  /** Last activity of the row (sorting: newest first). */
  endedAt: number
  /** `error`: the last call failed; `retried`: something failed or was retried but the row ended fine. */
  tone: CallTone
  error: string | null
  tokens: TokenBreakdown
  costUsd: number | null
  /** Wall time from the start of the first call to the end of the last one. */
  latencyMs: number | null
  /** Distinct models, most used first. */
  models: string[]
}

function started(call: LlmCallRow): number {
  return call.createdAt - (call.latencyMs ?? 0)
}

function rowOf(key: string, calls: LlmCallRow[], turn: DebugTurn | null): TurnRow {
  const chronological = [...calls].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
  const first = chronological[0] as LlmCallRow
  const last = chronological.at(-1) as LlmCallRow
  const tones = chronological.map(callTone)
  const lastTone = tones.at(-1) as CallTone
  const tone: CallTone =
    lastTone === 'error' || lastTone === 'running'
      ? lastTone
      : tones.some((t) => t === 'error' || t === 'retried')
        ? 'retried'
        : lastTone
  const costs = chronological.map((c) => c.costUsd)
  const known = costs.filter((c): c is number => c !== null)
  const counts = new Map<string, number>()
  for (const c of chronological) counts.set(c.model, (counts.get(c.model) ?? 0) + 1)
  const badge = turn ? (first.purpose === 'intro' ? 'intro' : null) : purposeBadge(first.purpose)
  return {
    key,
    turn,
    calls: [...chronological].reverse(),
    botId: turn?.botId ?? first.botId,
    badge,
    startedAt: started(first),
    endedAt: last.createdAt,
    tone,
    error: [...chronological].reverse().find((c) => c.error)?.error ?? null,
    tokens: tokenBreakdown(chronological),
    costUsd: known.length
      ? Math.max(
          known.reduce((a, b) => a + b, 0),
          turn?.costUsd ?? 0,
        )
      : null,
    latencyMs: last.latencyMs === null && chronological.length === 1 ? null : last.createdAt - started(first),
    models: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model),
  }
}

/** Rows newest first: one per turn, and one per call made outside a turn. */
export function turnRows(calls: LlmCallRow[], turns: DebugTurn[]): TurnRow[] {
  const turnById = new Map(turns.map((t) => [t.turnId, t]))
  const byTurn = new Map<string, LlmCallRow[]>()
  const rows: TurnRow[] = []
  for (const call of calls) {
    if (!call.turnId) {
      rows.push(rowOf(`call:${call.id}`, [call], null))
      continue
    }
    const list = byTurn.get(call.turnId) ?? []
    list.push(call)
    byTurn.set(call.turnId, list)
  }
  for (const [turnId, list] of byTurn) rows.push(rowOf(turnId, list, turnById.get(turnId) ?? null))
  return rows.sort((a, b) => b.endedAt - a.endedAt || (a.key < b.key ? 1 : -1))
}

/** Estimated tokens the tool result added to the context (recorded by the host), when known. */
export function toolResultTokens(result: unknown): number | null {
  const tokens = (result as { tokens?: unknown } | null)?.tokens
  return typeof tokens === 'number' && tokens > 0 ? tokens : null
}

/** Tool result text as stored by the runtime (`{isError, text}`), or its JSON. */
export function toolResultText(result: unknown): string {
  if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string')
    return result.text
  return result === null || result === undefined ? '' : JSON.stringify(result, null, 2)
}
