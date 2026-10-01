import {
  analyzeCron,
  formatTimeOfDay,
  nextRuns,
  parseCron,
  ScheduleError,
  type ScheduleShape,
  shapeToCron,
  type TimeOfDay,
} from '@milibot/shared'
import type { TFunction } from 'i18next'

const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]

const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i])

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

function dayOfMonth(day: number, locale: string, t: TFunction): string {
  if (day === 1) return t('routines.schedule.ordinalFirst')
  const category = new Intl.PluralRules(locale, { type: 'ordinal' }).select(day)
  return t(`routines.schedule.ordinal.${category}` as 'routines.schedule.ordinal.other', { n: day })
}

/** "Every 1st · 08:00", "Mon to Fri · 18:30", "Every 2 hours", "Custom · 0 8 1-7 * 1". */
export function describeSchedule(cron: string, locale: string, t: TFunction): string {
  const shape = analyzeCron(cron)
  switch (shape.kind) {
    case 'daily':
      return t('routines.schedule.daily', { time: formatTimeOfDay(shape.time) })
    case 'weekly': {
      const time = formatTimeOfDay(shape.time)
      if (same(shape.days, WEEKDAYS)) return t('routines.schedule.weekdays', { time })
      if (same(shape.days, WEEKEND)) return t('routines.schedule.weekend', { time })
      if (shape.days.length === 1) {
        const every = t('routines.schedule.every', { returnObjects: true }) as unknown as string[]
        return `${every[shape.days[0] as number] ?? ''} · ${time}`
      }
      const short = t('routines.schedule.short', { returnObjects: true }) as unknown as string[]
      const days = capitalize(shape.days.map((d) => short[d] ?? '').join(', '))
      return t('routines.schedule.days', { days, time })
    }
    case 'monthly':
      return t('routines.schedule.monthly', {
        day: dayOfMonth(shape.day, locale, t),
        time: formatTimeOfDay(shape.time),
      })
    case 'hourly':
      return shape.minute
        ? t('routines.schedule.hourlyAt', {
            count: shape.every,
            minute: String(shape.minute).padStart(2, '0'),
          })
        : t('routines.schedule.hourly', { count: shape.every })
    case 'minutes':
      return t('routines.schedule.minutes', { count: shape.every })
    case 'custom':
      return t('routines.schedule.custom', { cron: shape.cron })
  }
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "today 18:30", "tomorrow 08:00", "Thu, Oct 1 08:00". */
export function describeWhen(at: number, locale: string, t: TFunction, now = Date.now()): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at)
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000)
  if (days === 0) return t('routines.when.today', { time })
  if (days === 1) return t('routines.when.tomorrow', { time })
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(at)
  return t('routines.when.date', { date: date.replaceAll('.', ''), time })
}

/** "October 1st" (the "Routine created" card). */
export function formatDayMonth(at: number, locale: string, t: TFunction): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' })
    .formatToParts(at)
    .map((part) =>
      part.type === 'day' && part.value === '1' ? t('routines.schedule.ordinalFirst') : part.value,
    )
    .join('')
}

export type Frequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hourly' | 'minutes' | 'custom'

export const FREQUENCIES: Frequency[] = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'hourly',
  'minutes',
  'custom',
]
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12]
export const MINUTE_STEPS = [5, 10, 15, 20, 30]

/** State of the friendly schedule builder; every field is kept so switching frequency loses nothing. */
export interface ScheduleDraft {
  frequency: Frequency
  time: TimeOfDay
  days: number[]
  day: number
  hours: number
  minutes: number
  cron: string
}

export const DEFAULT_DRAFT: ScheduleDraft = {
  frequency: 'daily',
  time: { hour: 9, minute: 0 },
  days: [1],
  day: 1,
  hours: 2,
  minutes: 30,
  cron: '0 9 * * *',
}

export function draftFromCron(cron: string): ScheduleDraft {
  const shape = analyzeCron(cron)
  const draft: ScheduleDraft = { ...DEFAULT_DRAFT, cron }
  switch (shape.kind) {
    case 'daily':
      return { ...draft, frequency: 'daily', time: shape.time }
    case 'weekly':
      return same(shape.days, WEEKDAYS)
        ? { ...draft, frequency: 'weekdays', time: shape.time }
        : { ...draft, frequency: 'weekly', days: shape.days, time: shape.time }
    case 'monthly':
      return shape.day <= 28
        ? { ...draft, frequency: 'monthly', day: shape.day, time: shape.time }
        : { ...draft, frequency: 'custom' }
    case 'hourly':
      return shape.minute === 0
        ? { ...draft, frequency: 'hourly', hours: shape.every }
        : { ...draft, frequency: 'custom' }
    case 'minutes':
      return { ...draft, frequency: 'minutes', minutes: shape.every }
    case 'custom':
      return { ...draft, frequency: 'custom' }
  }
}

export function draftToCron(draft: ScheduleDraft): string {
  const shape: ScheduleShape =
    draft.frequency === 'daily'
      ? { kind: 'daily', time: draft.time }
      : draft.frequency === 'weekdays'
        ? { kind: 'weekly', days: WEEKDAYS, time: draft.time }
        : draft.frequency === 'weekly'
          ? draft.days.length === 7
            ? { kind: 'daily', time: draft.time }
            : { kind: 'weekly', days: [...draft.days].sort((a, b) => a - b), time: draft.time }
          : draft.frequency === 'monthly'
            ? { kind: 'monthly', day: draft.day, time: draft.time }
            : draft.frequency === 'hourly'
              ? { kind: 'hourly', every: draft.hours, minute: 0 }
              : draft.frequency === 'minutes'
                ? { kind: 'minutes', every: draft.minutes }
                : { kind: 'custom', cron: draft.cron }
  return shapeToCron(shape)
}

/** The next runs of a draft, or why its expression is invalid (the parser's English message). */
export function previewDraft(
  draft: ScheduleDraft,
  now = Date.now(),
): { cron: string; runs: number[] } | { error: string } {
  if (draft.frequency === 'weekly' && draft.days.length === 0) return { error: 'no days' }
  const cron = draftToCron(draft)
  try {
    const spec = parseCron(cron)
    const runs = nextRuns(spec, now, 3)
    if (runs.length === 0) return { error: 'never runs' }
    return { cron: spec.source, runs }
  } catch (err) {
    return { error: err instanceof ScheduleError ? err.message : 'invalid' }
  }
}

export function parseTime(value: string): TimeOfDay | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour < 24 && minute < 60 ? { hour, minute } : null
}
