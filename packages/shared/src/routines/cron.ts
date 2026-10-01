/*
 * Routine schedules: 5-field cron expressions evaluated in the host's local time zone. Pure functions shared
 * by the daemon (scheduler, bot tools) and the app (schedule builder, labels).
 */

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleError'
  }
}

/** Routines never run more often than this (cost guard). */
export const MIN_ROUTINE_INTERVAL_MINUTES = 5

interface FieldRange {
  min: number
  max: number
  names?: Record<string, number>
}

const MONTH_NAMES = Object.fromEntries(
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((n, i) => [
    n,
    i + 1,
  ]),
)
const DAY_NAMES = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((n, i) => [n, i]))

const FIELDS: FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DAY_NAMES },
]
const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week']

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

export interface CronSpec {
  /** Normalized expression (macros expanded, single spaces). */
  source: string
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  /** 0 = Sunday (7 is folded into 0). */
  weekdays: number[]
  /** The field was `*` (or `*` with a step): matters for the day-of-month/day-of-week OR rule. */
  dayAny: boolean
  weekdayAny: boolean
}

function parseValue(raw: string, field: FieldRange, name: string): number {
  const named = field.names?.[raw]
  const value = named ?? (/^\d+$/.test(raw) ? Number(raw) : NaN)
  if (!Number.isInteger(value) || value < field.min || value > field.max) {
    throw new ScheduleError(`Invalid ${name} "${raw}" (allowed ${field.min}-${field.max})`)
  }
  return value
}

function parseField(raw: string, field: FieldRange, name: string): number[] {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    if (!part) throw new ScheduleError(`Empty value in the ${name} field`)
    const [range = '', stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1)
      throw new ScheduleError(`Invalid step "${stepRaw}" in the ${name} field`)
    let from: number
    let to: number
    if (range === '*') {
      from = field.min
      to = field.max
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-')
      from = parseValue(a, field, name)
      to = parseValue(b, field, name)
      if (from > to) throw new ScheduleError(`Invalid range "${range}" in the ${name} field`)
    } else {
      from = parseValue(range, field, name)
      to = stepRaw === undefined ? from : field.max
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return [...values].sort((a, b) => a - b)
}

/** Parses a 5-field cron expression (`minute hour day month weekday`, names and `@daily` style macros allowed). */
export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim().toLowerCase().replace(/\s+/g, ' ')
  const source = MACROS[trimmed] ?? trimmed
  const parts = source.split(' ')
  if (parts.length !== 5) {
    throw new ScheduleError(
      `A cron expression has 5 fields (minute hour day month weekday); got "${expression}"`,
    )
  }
  const [minutes, hours, days, months, weekdaysRaw] = parts.map((p, i) =>
    parseField(p, FIELDS[i] as FieldRange, FIELD_NAMES[i] as string),
  ) as [number[], number[], number[], number[], number[]]
  const weekdays = [...new Set(weekdaysRaw.map((d) => d % 7))].sort((a, b) => a - b)
  return {
    source,
    minutes,
    hours,
    days,
    months,
    weekdays,
    dayAny: (parts[2] as string).startsWith('*'),
    weekdayAny: (parts[4] as string).startsWith('*'),
  }
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.months.includes(date.getMonth() + 1)) return false
  const dom = spec.days.includes(date.getDate())
  const dow = spec.weekdays.includes(date.getDay())
  // Vixie cron: when both day fields are restricted, either one matching is enough.
  if (!spec.dayAny && !spec.weekdayAny) return dom || dow
  return dom && dow
}

/** Enough days to find Feb 29 on a given weekday. */
const SEARCH_DAYS = 366 * 29

/**
 * First run strictly after `after` (epoch ms), in the local time zone. A wall-clock time skipped by a
 * DST change runs at the shifted instant (02:30 → 03:30); a repeated one runs once (the first).
 * Null when the expression never matches (e.g. 31 February).
 */
export function nextRunAfter(cron: string | CronSpec, after: number): number | null {
  const spec = typeof cron === 'string' ? parseCron(cron) : cron
  const start = Math.floor(after / 60_000) * 60_000 + 60_000
  const first = new Date(start)
  const day = new Date(first.getFullYear(), first.getMonth(), first.getDate(), 12)
  for (let i = 0; i < SEARCH_DAYS; i++) {
    if (dayMatches(spec, day)) {
      const y = day.getFullYear()
      const m = day.getMonth()
      const d = day.getDate()
      for (const hour of spec.hours) {
        for (const minute of spec.minutes) {
          const at = new Date(y, m, d, hour, minute).getTime()
          if (at >= start) return at
        }
      }
    }
    day.setDate(day.getDate() + 1)
  }
  return null
}

/** The next `count` runs after `after`. */
export function nextRuns(cron: string | CronSpec, after: number, count: number): number[] {
  const spec = typeof cron === 'string' ? parseCron(cron) : cron
  const runs: number[] = []
  let cursor = after
  while (runs.length < count) {
    const next = nextRunAfter(spec, cursor)
    if (next === null) break
    runs.push(next)
    cursor = next
  }
  return runs
}

/**
 * Validates a cron expression for a routine: parses, runs at least once and not more often than
 * every {@link MIN_ROUTINE_INTERVAL_MINUTES} minutes. Returns the normalized expression.
 */
export function validateRoutineCron(expression: string, now: number = Date.now()): string {
  const spec = parseCron(expression)
  const runs = nextRuns(spec, now, 24)
  if (runs.length === 0) throw new ScheduleError(`"${expression}" never runs (no such date)`)
  for (let i = 1; i < runs.length; i++) {
    if ((runs[i] as number) - (runs[i - 1] as number) < MIN_ROUTINE_INTERVAL_MINUTES * 60_000) {
      throw new ScheduleError(
        `"${expression}" runs too often: routines run at most every ${MIN_ROUTINE_INTERVAL_MINUTES} minutes`,
      )
    }
  }
  return spec.source
}

export interface TimeOfDay {
  hour: number
  minute: number
}

export type ScheduleShape =
  | { kind: 'daily'; time: TimeOfDay }
  /** Some days of the week (0 = Sunday); `[1..5]` is Mon–Fri. */
  | { kind: 'weekly'; days: number[]; time: TimeOfDay }
  | { kind: 'monthly'; day: number; time: TimeOfDay }
  /** Every N hours at minute M (N divides 24). */
  | { kind: 'hourly'; every: number; minute: number }
  /** Every N minutes (N divides 60). */
  | { kind: 'minutes'; every: number }
  | { kind: 'custom'; cron: string }

export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12]
export const MINUTE_STEPS = [5, 10, 15, 20, 30]
const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i)

function isStepSeries(values: number[], step: number, size: number): boolean {
  if (values.length !== size / step) return false
  return values.every((v, i) => v === i * step)
}

function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Recognizes the schedules the builder can edit; anything else is `custom`. */
export function analyzeCron(cron: string): ScheduleShape {
  let spec: CronSpec
  try {
    spec = parseCron(cron)
  } catch {
    return { kind: 'custom', cron }
  }
  const everyMonth = spec.months.length === 12
  const everyDay = spec.dayAny && spec.weekdayAny
  const single = spec.minutes.length === 1 && spec.hours.length === 1
  const time = { hour: spec.hours[0] as number, minute: spec.minutes[0] as number }
  if (everyMonth && single) {
    if (everyDay) return { kind: 'daily', time }
    if (spec.dayAny && !spec.weekdayAny) {
      return spec.weekdays.length === 7
        ? { kind: 'daily', time }
        : { kind: 'weekly', days: spec.weekdays, time }
    }
    if (!spec.dayAny && spec.weekdayAny && spec.days.length === 1)
      return { kind: 'monthly', day: spec.days[0] as number, time }
  }
  if (everyMonth && everyDay && spec.minutes.length === 1) {
    const every = HOUR_STEPS.find((step) => isStepSeries(spec.hours, step, 24))
    if (every) return { kind: 'hourly', every, minute: spec.minutes[0] as number }
  }
  if (everyMonth && everyDay && sameList(spec.hours, ALL_HOURS)) {
    const every = MINUTE_STEPS.find((step) => isStepSeries(spec.minutes, step, 60))
    if (every) return { kind: 'minutes', every }
  }
  return { kind: 'custom', cron: spec.source }
}

function weekdayList(days: number[]): string {
  const sorted = [...new Set(days.map((d) => d % 7))].sort((a, b) => a - b)
  const ranges: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j++
    ranges.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(','))
    i = j + 1
  }
  return ranges.join(',')
}

export function shapeToCron(shape: ScheduleShape): string {
  switch (shape.kind) {
    case 'daily':
      return `${shape.time.minute} ${shape.time.hour} * * *`
    case 'weekly':
      return `${shape.time.minute} ${shape.time.hour} * * ${weekdayList(shape.days)}`
    case 'monthly':
      return `${shape.time.minute} ${shape.time.hour} ${shape.day} * *`
    case 'hourly':
      return `${shape.minute} ${shape.every === 1 ? '*' : `*/${shape.every}`} * * *`
    case 'minutes':
      return `*/${shape.every} * * * *`
    case 'custom':
      return shape.cron.trim()
  }
}

export function formatTimeOfDay(time: TimeOfDay): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
}
