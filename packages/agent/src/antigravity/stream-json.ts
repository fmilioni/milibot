import type { TokenUsage } from '../llm/usage'

/** A tool call as `agy` reports it: summarized parameters (file contents left out) and, once done, its output. */
export interface AgyToolInfo {
  name: string
  parameters: Record<string, unknown>
  output: string | null
}

/**
 * What `agy --output-format stream-json` prints, one event per line: `init` once, before the first input is
 * read; a `step_update` per change of a step of the conversation; a `result` closing each input.
 */
export type AntigravityEvent =
  | { type: 'init'; conversationId: string; model: string | null }
  | {
      type: 'step'
      index: number
      /** `ACTIVE` while it runs, `DONE` once finished (other values: it failed or was cancelled). */
      state: string
      stepType: string
      textDelta: string | null
      tool: AgyToolInfo | null
      /** Tokens of the model request a finished `agent_response` step made. */
      usage: TokenUsage | null
      durationMs: number | null
    }
  | {
      type: 'result'
      conversationId: string | null
      ok: boolean
      status: string
      text: string
      error: string | null
      durationMs: number | null
    }

type Json = Record<string, unknown>

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const ms = (seconds: unknown): number | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null

/** `agy`'s usage block: input excludes cache reads, output includes the thinking tokens. */
function antigravityTokens(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Json
  const thinking = num(u.thinking_tokens)
  return {
    inputTokens: num(u.input_tokens),
    cachedReadTokens: num(u.cache_read_tokens),
    cacheWriteTokens: 0,
    outputTokens: Math.max(0, num(u.output_tokens) - thinking),
    reasoningTokens: thinking,
  }
}

function toolInfo(raw: unknown): AgyToolInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Json
  const name = str(t.name)
  if (!name) return null
  const parameters = t.parameters && typeof t.parameters === 'object' ? (t.parameters as Json) : {}
  return { name, parameters, output: str(t.output) }
}

/** One stdout line of `agy` in stream-json; null for anything else (its own notices, blank lines). */
export function parseAntigravityLine(line: string): AntigravityEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const event = parsed as Json
  if (event.event === 'init') {
    const init = (event.init ?? {}) as Json
    const conversationId = str(event.conversation_id)
    return conversationId ? { type: 'init', conversationId, model: str(init.model) } : null
  }
  if (event.event === 'step_update') {
    const step = (event.step_update ?? {}) as Json
    return {
      type: 'step',
      index: num(step.step_index),
      state: str(step.state) ?? '',
      stepType: str(step.step_type) ?? '',
      textDelta: str(step.text_delta),
      tool: toolInfo(step.tool_info) ?? (str(step.tool_name) ? toolInfo({ name: step.tool_name }) : null),
      usage: antigravityTokens(step.usage),
      durationMs: ms(step.duration_seconds),
    }
  }
  if (event.event === 'result') {
    const result = (event.result ?? {}) as Json
    const status = str(result.status) ?? 'ERROR'
    return {
      type: 'result',
      conversationId: str(result.conversation_id) || null,
      ok: status === 'SUCCESS',
      status,
      text: str(result.response) ?? '',
      error: str(result.error),
      durationMs: ms(result.duration_seconds),
    }
  }
  return null
}

/** A user message on `agy`'s stdin (`--input-format stream-json`). */
export function antigravityInputLine(text: string): string {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`
}
