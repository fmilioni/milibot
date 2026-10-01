import { foldText } from '../core/text'
import {
  HOUR_STEPS,
  MIN_ROUTINE_INTERVAL_MINUTES,
  MINUTE_STEPS,
  ScheduleError,
  type ScheduleShape,
  shapeToCron,
  type TimeOfDay,
  validateRoutineCron,
} from './cron'

// Portuguese on purpose: the friendly phrasing people write in chat ("todo dia 08:00", "seg a sex 18:30").

const SCHEDULE_EXAMPLES = [
  'todo dia 08:00',
  'seg a sex 18:30',
  'toda segunda 9h',
  'todo dia 1º 08:00',
  'a cada 2 horas',
  'every day at 8am',
  'weekdays 6:30pm',
  '0 8 * * 1-5',
] as const

const DEFAULT_TIME = { hour: 9, minute: 0 }

function fold(text: string): string {
  return foldText(text).replace(/[º°ª]/g, 'o').replace(/\s+/g, ' ').trim()
}

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/^(dom|domingos?|sun|sundays?)$/, 0],
  [/^(seg|segundas?|segunda-feira|segundas-feiras|mon|mondays?)$/, 1],
  [/^(ter|tercas?|terca-feira|tercas-feiras|tue|tues|tuesdays?)$/, 2],
  [/^(qua|quartas?|quarta-feira|quartas-feiras|wed|wednesdays?)$/, 3],
  [/^(qui|quintas?|quinta-feira|quintas-feiras|thu|thur|thurs|thursdays?)$/, 4],
  [/^(sex|sextas?|sexta-feira|sextas-feiras|fri|fridays?)$/, 5],
  [/^(sab|sabados?|sat|saturdays?)$/, 6],
]

function weekdayOf(word: string): number | null {
  const clean = word.replace(/[.,;]$/, '')
  for (const [re, day] of WEEKDAY_WORDS) if (re.test(clean)) return day
  return null
}

const TIME_RE =
  /(?:\b(?:as|a|at)\s+)?\b(\d{1,2})(?:(?::|h)(\d{2})?)?\s*(am|pm|a\.m\.|p\.m\.)?(?:\s+(?:da|de)\s+(manha|tarde|noite|madrugada))?(?=\s|$|,|\.)/g

interface FoundTime {
  time: TimeOfDay
  start: number
  end: number
}

/** Times written as 08:00, 8h, 8h30, 18h, 8am, 6:30pm, "8 da noite", meio-dia/noon, meia-noite/midnight. */
function findTime(text: string): FoundTime | null {
  const named: Array<[RegExp, TimeOfDay]> = [
    [/\b(ao |as )?(meio-dia|meio dia|noon)\b/, { hour: 12, minute: 0 }],
    [/\b(a |as )?(meia-noite|meia noite|midnight)\b/, { hour: 0, minute: 0 }],
  ]
  for (const [re, time] of named) {
    const m = re.exec(text)
    if (m) return { time, start: m.index, end: m.index + m[0].length }
  }
  for (const m of text.matchAll(TIME_RE)) {
    const [whole, hRaw, mRaw, ampm, period] = m
    const marked = whole.includes(':') || /\dh/.test(whole) || ampm || period
    const introduced = /^(as|a|at)\s/.test(whole)
    if (!marked && !introduced) continue
    let hour = Number(hRaw)
    const minute = mRaw ? Number(mRaw) : 0
    const pm = ampm?.startsWith('p') || period === 'tarde' || period === 'noite'
    const am = ampm?.startsWith('a') || period === 'manha' || period === 'madrugada'
    if (pm && hour < 12) hour += 12
    if (am && hour === 12) hour = 0
    if (hour > 23 || minute > 59) throw new ScheduleError(`Invalid time "${whole.trim()}"`)
    return { time: { hour, minute }, start: m.index, end: m.index + whole.length }
  }
  return null
}

function interval(text: string): ScheduleShape | null {
  if (/\b(de hora em hora|a cada hora|toda hora|todas as horas|every hour|hourly|each hour)\b/.test(text))
    return { kind: 'hourly', every: 1, minute: 0 }
  const m =
    /\b(?:a cada|cada|every|each)\s+(\d+)\s*(minutos?|mins?|minutes?|m|horas?|hours?|hrs?|h)\b/.exec(text) ??
    /\bde\s+(\d+)\s+em\s+\d+\s*(minutos?|horas?)\b/.exec(text)
  if (!m) {
    if (/\b(a cada minuto|every minute)\b/.test(text))
      throw new ScheduleError(`Routines run at most every ${MIN_ROUTINE_INTERVAL_MINUTES} minutes`)
    return null
  }
  const every = Number(m[1])
  const unit = m[2] as string
  if (unit.startsWith('m')) {
    if (every < MIN_ROUTINE_INTERVAL_MINUTES)
      throw new ScheduleError(`Routines run at most every ${MIN_ROUTINE_INTERVAL_MINUTES} minutes`)
    if (every === 60) return { kind: 'hourly', every: 1, minute: 0 }
    if (!MINUTE_STEPS.includes(every))
      throw new ScheduleError(
        `Every ${every} minutes does not divide the hour; use ${MINUTE_STEPS.join(', ')} minutes`,
      )
    return { kind: 'minutes', every }
  }
  if (every === 24) return null
  if (!HOUR_STEPS.includes(every))
    throw new ScheduleError(
      `Every ${every} hours does not divide the day; use ${HOUR_STEPS.join(', ')} hours`,
    )
  return { kind: 'hourly', every, minute: 0 }
}

function weekdays(text: string): number[] | null {
  if (/\b(dias? uteis|dia util|weekdays?|business days?|work ?days?)\b/.test(text)) return [1, 2, 3, 4, 5]
  if (/\b(fim de semana|fins de semana|finais de semana|final de semana|weekends?)\b/.test(text))
    return [0, 6]
  const words = text.split(/[\s,/]+/)
  const days = new Set<number>()
  for (let i = 0; i < words.length; i++) {
    const day = weekdayOf(words[i] as string)
    if (day === null) continue
    const joiner = words[i + 1]
    const next = words[i + 2] !== undefined ? weekdayOf(words[i + 2] as string) : null
    if ((joiner === 'a' || joiner === 'ate' || joiner === 'to' || joiner === 'through') && next !== null) {
      for (let d = day; ; d = (d + 1) % 7) {
        days.add(d)
        if (d === next) break
      }
      i += 2
      continue
    }
    days.add(day)
  }
  for (const word of words) {
    const dash = /^([a-z]+)-([a-z]+)$/.exec(word)
    if (!dash) continue
    const a = weekdayOf(dash[1] as string)
    const b = weekdayOf(dash[2] as string)
    if (a === null || b === null) continue
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d)
      if (d === b) break
    }
  }
  return days.size ? [...days].sort((a, b) => a - b) : null
}

function monthDay(text: string): number | null {
  const patterns = [
    /\bdia (\d{1,2})o?\b/,
    /\b(\d{1,2})o\b/,
    /\b(\d{1,2})(?:st|nd|rd|th)\b/,
    /\bday (\d{1,2})\b/,
    /\bprimeiro dia\b/,
    /\bfirst day\b/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (!m) continue
    const day = m[1] ? Number(m[1]) : 1
    if (day < 1 || day > 31) throw new ScheduleError(`Invalid day of the month "${day}"`)
    if (day > 28)
      throw new ScheduleError(
        `Day ${day} does not exist in every month; pick a day up to 28 so the routine runs every month`,
      )
    return day
  }
  return null
}

const CRON_LIKE = /^(@[a-z]+|[\d*a-z,\-/]+( [\d*a-z,\-/]+){4})$/

function unknownSchedule(text: string): ScheduleError {
  return new ScheduleError(
    `Could not understand the schedule "${text}". Examples: ${SCHEDULE_EXAMPLES.map((e) => `"${e}"`).join(', ')}`,
  )
}

/**
 * Turns what the user asked ("todo dia 08:00", "seg a sex 18:30", "todo dia 1º", "a cada 2 horas",
 * "every monday at 9am", or a cron expression) into a validated cron expression.
 * Throws {@link ScheduleError} with examples when it cannot.
 */
export function parseSchedule(input: string, now: number = Date.now()): string {
  const raw = input.trim()
  if (!raw) throw unknownSchedule(input)
  const text = fold(raw)
  if (CRON_LIKE.test(text)) {
    try {
      return validateRoutineCron(text, now)
    } catch (err) {
      if (text.startsWith('@') || /^[\d*/,-]+ [\d*/,-]+ /.test(text)) throw err
    }
  }
  const every = interval(text)
  if (every) return validateRoutineCron(shapeToCron(every), now)

  const found = findTime(text)
  const time = found?.time ?? DEFAULT_TIME
  const rest = found
    ? `${text.slice(0, found.start)} ${text.slice(found.end)}`.replace(/\s+/g, ' ').trim()
    : text

  const monthly = /\b(mes|mensal|mensalmente|month|monthly)\b/.test(rest) || /\bdia \d/.test(rest)
  const day = monthDay(rest)
  if (day !== null && (monthly || !weekdays(rest))) {
    return validateRoutineCron(shapeToCron({ kind: 'monthly', day, time }), now)
  }
  if (monthly && /\b(todo|todos|every|each|mensal|mensalmente|monthly)\b/.test(rest)) {
    return validateRoutineCron(shapeToCron({ kind: 'monthly', day: 1, time }), now)
  }
  const days = weekdays(rest)
  if (days) {
    const shape: ScheduleShape = days.length === 7 ? { kind: 'daily', time } : { kind: 'weekly', days, time }
    return validateRoutineCron(shapeToCron(shape), now)
  }
  if (
    /\b(todo dia|todos os dias|diariamente|diario|every day|everyday|daily|each day)\b/.test(rest) ||
    (found && !rest.replace(/\b(as|a|at|todo|every|de|do|da)\b/g, '').trim())
  ) {
    return validateRoutineCron(shapeToCron({ kind: 'daily', time }), now)
  }
  throw unknownSchedule(raw)
}
