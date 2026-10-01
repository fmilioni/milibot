import type { ToolCall } from '../llm/messages'
import { ToolInputError } from './result'

export type ToolArgs = Record<string, unknown>

/** Arguments as the model wrote them; invalid JSON is kept for `toolArgs` to report. */
export function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __invalidJson: raw }
  }
}

/** The call's arguments as an object ({} when absent); arguments that were not valid JSON are an input error. */
export function toolArgs(call: Pick<ToolCall, 'arguments'>): ToolArgs {
  const a = call.arguments
  if (!a || typeof a !== 'object' || Array.isArray(a)) return {}
  if ('__invalidJson' in a)
    throw new ToolInputError(
      `arguments are not valid JSON: ${String((a as ToolArgs).__invalidJson).slice(0, 200)}`,
    )
  return a as ToolArgs
}

export function requireString(a: ToolArgs, key: string): string {
  const value = a[key]
  if (typeof value !== 'string' || value.length === 0) throw new ToolInputError(`"${key}" is required`)
  return value
}

export function optionalString(a: ToolArgs, key: string): string | undefined {
  const value = a[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A number rounded and clamped to [min, max]; null when absent. */
export function optionalInteger(a: ToolArgs, key: string, min: number, max: number): number | null {
  const value = a[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ToolInputError(`"${key}" must be a number`)
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function optionalBoolean(a: ToolArgs, key: string): boolean | undefined {
  const value = a[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ToolInputError(`"${key}" must be true or false`)
  return value
}

/** A string argument trimmed; '' for anything else. */
export function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A string argument trimmed and cut to `max` characters; '' for anything else. */
export function textArg(a: ToolArgs, key: string, max = Infinity): string {
  return trimmedString(a[key]).slice(0, max)
}

/** A string argument as given (content keeps its whitespace); '' for anything else. */
export function rawTextArg(a: ToolArgs, key: string): string {
  const value = a[key]
  return typeof value === 'string' ? value : ''
}

/** A number clamped to [min, max] (rounded with `round`); `fallback` when absent or not a number. */
export function numberArg(
  a: ToolArgs,
  key: string,
  range: { min: number; max: number; fallback: number; round?: boolean },
): number {
  const value = a[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return range.fallback
  const n = range.round ? Math.round(value) : value
  return Math.max(range.min, Math.min(range.max, n))
}

/** A number as given; undefined when absent or not a number. */
export function optionalNumber(a: ToolArgs, key: string): number | undefined {
  const value = a[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** An integer, also written as a numeric string ("12"), rounded; null for anything else. */
export function optionalIntLike(a: ToolArgs, key: string): number | null {
  const value = a[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

/** An integer as given (fractions refused); null for anything else. */
export function exactInteger(a: ToolArgs, key: string): number | null {
  const value = a[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** A boolean argument; undefined for anything else (unlike `optionalBoolean`, never an error). */
export function flagArg(a: ToolArgs, key: string): boolean | undefined {
  const value = a[key]
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The non-empty strings of a list argument, trimmed; a single string counts as a one-item list (split on
 * `split` when given). Items that aren't strings are skipped.
 */
export function stringListArg(a: ToolArgs, key: string, options: { split?: string } = {}): string[] {
  const value = a[key]
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? options.split
        ? value.split(options.split)
        : [value]
      : []
  return items.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
}

/** The arguments as an object ({} when absent), without the JSON check of `toolArgs` (for describing calls). */
export function argsObject(value: unknown): ToolArgs {
  return (value && typeof value === 'object' ? value : {}) as ToolArgs
}
