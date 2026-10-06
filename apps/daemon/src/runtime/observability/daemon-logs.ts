import { open } from 'node:fs/promises'

import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  flagArg,
  optionalIntLike,
  optionalString,
  type ToolArgs,
  ToolInputError,
  toolText,
} from '@milibot/agent/tools'
import type { Bot } from '@milibot/shared'

import { type ToolHandlers, ToolSwitch } from '../tools-core'

const DEFAULT_SINCE_MS = 60 * 60_000
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
/** Bytes read back from the end at most per call: the file of a long-running daemon has many MB. */
export const MAX_READ_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const MAX_VALUE_CHARS = 300

const LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }
const LEVEL_NAMES = Object.fromEntries(Object.entries(LEVELS).map(([name, n]) => [n, name.toUpperCase()]))
/** Fields every pino record has, or that the line's prefix already shows. */
const SHOWN_APART = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'workspaceId', 'botId', 'botName'])

const DURATION = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d)$/i
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * Credentials a log line may carry that no stored secret matches (a provider's token in an error, an
 * Authorization header). Known secret values are redacted after, by the tool registry.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [
    /("?(?:authorization|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie)"?\s*[:=]\s*"?)(?!\d+\b)[^\s",}&]{4,}/gi,
    '$1[REDACTED]',
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED]'],
]

export function redactLogText(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export interface DaemonLogToolsDeps {
  workspaceId: string
  /** The daemon's log file; null: this daemon does not write one (run from a terminal). */
  path: string | null
  resolveBot(ref: string): Bot | null
  botName(id: string): string | null
  now(): number
}

interface Query {
  sinceMs: number
  minLevel: number
  botId: string | null
  contains: string | null
  limit: number
  supervisor: boolean
}

export function parseSince(value: string | undefined, now: number): number {
  if (!value) return now - DEFAULT_SINCE_MS
  const duration = DURATION.exec(value.trim())
  if (duration) return now - Number(duration[1]) * (UNIT_MS[(duration[2] as string).toLowerCase()] ?? 0)
  const at = Date.parse(value)
  if (Number.isNaN(at))
    throw new ToolInputError('"since" must be an ISO time or a duration like "30m" or "2h"')
  return at
}

function parseQuery(ctx: ToolExecContext, a: ToolArgs, deps: DaemonLogToolsDeps): Query {
  const level = optionalString(a, 'level')?.toLowerCase() ?? 'info'
  const minLevel = LEVELS[level]
  if (minLevel === undefined) throw new ToolInputError('"level" must be debug, info, warn or error')
  const ref = optionalString(a, 'bot')?.trim()
  let botId: string | null = null
  if (ref) {
    const bot = ref.toLowerCase() === 'me' ? ctx.bot : deps.resolveBot(ref)
    if (!bot) throw new ToolInputError(`There is no bot named "${ref}" (use list_bots).`)
    botId = bot.id
  }
  const limit = optionalIntLike(a, 'limit')
  return {
    sinceMs: parseSince(optionalString(a, 'since'), deps.now()),
    minLevel,
    botId,
    contains: optionalString(a, 'contains')?.toLowerCase() ?? null,
    limit: Math.max(1, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT)),
    supervisor: flagArg(a, 'include_supervisor') ?? false,
  }
}

function pad(n: number, size = 2): string {
  return String(n).padStart(size, '0')
}

function localTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function shortValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = (text ?? '').replace(/\s+/g, ' ')
  return flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS)}…` : flat
}

/** One record as a compact line, or null when the query leaves it out. */
function formatLine(
  line: string,
  query: Query,
  deps: DaemonLogToolsDeps,
): { text: string; time: number | null } | null {
  let record: Record<string, unknown> | null = null
  if (line.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        record = parsed as Record<string, unknown>
    } catch {
      record = null
    }
  }
  if (query.contains && !line.toLowerCase().includes(query.contains)) return null
  if (query.botId && !line.includes(query.botId)) return null
  if (!record) {
    // Not a pino record (a crash's stack trace, a warning a library printed): no workspace to scope it by.
    if (!query.supervisor && !query.contains) return null
    return { text: `[raw] ${shortValue(line)}`, time: null }
  }
  const time = typeof record.time === 'number' ? record.time : null
  if (record.workspaceId !== undefined && record.workspaceId !== deps.workspaceId) return null
  if (record.workspaceId === undefined && !query.supervisor) return null
  const level = typeof record.level === 'number' ? record.level : 30
  if (level < query.minLevel) return null
  const botId = typeof record.botId === 'string' ? record.botId : null
  const who =
    record.workspaceId === undefined
      ? '[supervisor]'
      : typeof record.botName === 'string'
        ? record.botName
        : botId
          ? (deps.botName(botId) ?? botId)
          : '-'
  const extras = Object.entries(record)
    .filter(([key, value]) => !SHOWN_APART.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${shortValue(value)}`)
  const levelName = LEVEL_NAMES[level] ?? String(level)
  const head = `${time === null ? '?' : localTime(time)} ${levelName} ${who}: ${shortValue(record.msg ?? '')}`
  return { text: extras.length ? `${head} ${extras.join(' ')}` : head, time }
}

type Stop = 'limit' | 'since' | 'start' | 'cap'

/** Lines of the file from its end back, stopping at the query's limit, its start time or the read cap. */
export async function readDaemonLog(
  path: string,
  query: Query,
  deps: DaemonLogToolsDeps,
  maxBytes = MAX_READ_BYTES,
): Promise<{ lines: string[]; stop: Stop }> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const found: string[] = []
    let position = size
    let carry = Buffer.alloc(0)
    let read = 0
    const take = (raw: string): Stop | null => {
      const line = raw.trim()
      if (!line) return null
      const shown = formatLine(line, query, deps)
      if (shown?.time != null && shown.time < query.sinceMs) return 'since'
      if (!shown) {
        // Records left out still tell how far back the file is.
        const time = /"time":(\d{10,})/.exec(line)?.[1]
        return time && Number(time) < query.sinceMs ? 'since' : null
      }
      found.push(shown.text)
      return found.length >= query.limit ? 'limit' : null
    }
    while (position > 0) {
      if (read >= maxBytes) return { lines: found.reverse(), stop: 'cap' }
      const length = Math.min(CHUNK_BYTES, position, maxBytes - read)
      position -= length
      read += length
      const chunk = Buffer.alloc(length)
      await file.read(chunk, 0, length, position)
      const buffer = Buffer.concat([chunk, carry])
      let end = buffer.length
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] !== 0x0a) continue
        const stop = take(buffer.subarray(i + 1, end).toString('utf8'))
        if (stop) return { lines: found.reverse(), stop }
        end = i
      }
      carry = buffer.subarray(0, end)
    }
    const stop = take(carry.toString('utf8'))
    return { lines: found.reverse(), stop: stop ?? 'start' }
  } finally {
    await file.close()
  }
}

const STOP_NOTE: Record<Stop, (query: Query) => string> = {
  limit: (q) =>
    `limit of ${q.limit} lines reached: older matching lines exist (narrow the filters or raise limit)`,
  since: () => 'all matching lines since the start time',
  start: () => 'start of the log file reached',
  cap: () =>
    `read cap of ${MAX_READ_BYTES / 1024 / 1024} MB reached: older lines were not read (narrow "since")`,
}

async function daemonLogs(ctx: ToolExecContext, a: ToolArgs, deps: DaemonLogToolsDeps): Promise<ToolResult> {
  const query = parseQuery(ctx, a, deps)
  const missing = toolText(
    'The daemon is not writing its log to a file in this run (it was started from a terminal), so there is ' +
      'nothing to read.',
  )
  if (!deps.path) return missing
  let result: Awaited<ReturnType<typeof readDaemonLog>>
  try {
    result = await readDaemonLog(deps.path, query, deps)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return missing
    throw err
  }
  const footer = `-- ${result.lines.length} line(s); ${STOP_NOTE[result.stop](query)}`
  const body = result.lines.length ? result.lines.join('\n') : 'No matching lines.'
  return toolText(redactLogText(`${body}\n${footer}`))
}

/** `daemon_logs`: a bot reads the daemon's log of its own workspace to find out what went wrong. */
export class DaemonLogTools extends ToolSwitch {
  readonly name = 'diagnostics'
  protected readonly handlers: ToolHandlers

  constructor(deps: DaemonLogToolsDeps) {
    super()
    this.handlers = { daemon_logs: (ctx, a) => daemonLogs(ctx, a, deps) }
  }
}
