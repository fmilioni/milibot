import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  analyzeCron,
  nextRunAfter,
  nextRuns,
  parseCron,
  ScheduleError,
  shapeToCron,
  validateRoutineCron,
} from './cron'
import { parseSchedule } from './schedule'

beforeAll(() => {
  vi.stubEnv('TZ', 'America/New_York')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
const fmt = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('parseCron', () => {
  it('parses lists, ranges, steps and names', () => {
    const spec = parseCron('0,30 8-10 */10 jan-mar mon-fri')
    expect(spec.minutes).toEqual([0, 30])
    expect(spec.hours).toEqual([8, 9, 10])
    expect(spec.days).toEqual([1, 11, 21, 31])
    expect(spec.months).toEqual([1, 2, 3])
    expect(spec.weekdays).toEqual([1, 2, 3, 4, 5])
    expect(parseCron('0 0 * * 7').weekdays).toEqual([0])
    expect(parseCron('5/15 * * * *').minutes).toEqual([5, 20, 35, 50])
    expect(parseCron('@daily').source).toBe('0 0 * * *')
  })

  it('rejects malformed expressions', () => {
    for (const bad of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '5-1 * * * *',
      '*/0 * * * *',
      'x * * * *',
    ]) {
      expect(() => parseCron(bad), bad).toThrow(ScheduleError)
    }
  })
})

describe('nextRunAfter', () => {
  it('finds the next local run strictly after the given instant', () => {
    expect(fmt(nextRunAfter('0 8 * * *', local(2026, 9, 26, 7, 59)) as number)).toBe('2026-09-26 08:00')
    expect(fmt(nextRunAfter('0 8 * * *', local(2026, 9, 26, 8, 0)) as number)).toBe('2026-09-27 08:00')
    expect(fmt(nextRunAfter('30 18 * * 1-5', local(2026, 9, 25, 19)) as number)).toBe('2026-09-28 18:30')
  })

  it('handles month ends and leap days', () => {
    expect(fmt(nextRunAfter('0 8 31 * *', local(2026, 9, 1)) as number)).toBe('2026-10-31 08:00')
    expect(fmt(nextRunAfter('0 8 1 * *', local(2026, 12, 31, 23, 59)) as number)).toBe('2027-01-01 08:00')
    expect(fmt(nextRunAfter('0 0 29 2 *', local(2026, 3, 1)) as number)).toBe('2028-02-29 00:00')
    expect(nextRunAfter('0 0 30 2 *', local(2026, 1, 1))).toBeNull()
  })

  it('uses OR when both day fields are restricted', () => {
    const runs = nextRuns('0 9 13 * 5', local(2026, 11, 1), 3).map(fmt)
    expect(runs).toEqual(['2026-11-06 09:00', '2026-11-13 09:00', '2026-11-20 09:00'])
  })

  it('runs a time skipped by the spring DST change once, at the shifted instant', () => {
    // 2026-03-08 02:00 EST → 03:00 EDT in New York.
    const daily = nextRunAfter('30 2 * * *', local(2026, 3, 7, 12)) as number
    expect(iso(daily)).toBe('2026-03-08T07:30:00.000Z')
    expect(fmt(daily)).toBe('2026-03-08 03:30')
    const hourly = nextRuns('30 * * * *', local(2026, 3, 8, 1, 0), 3).map(iso)
    expect(hourly).toEqual([
      '2026-03-08T06:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-08T08:30:00.000Z',
    ])
  })

  it('runs a repeated wall-clock time once on the fall DST change', () => {
    // 2026-11-01 02:00 EDT → 01:00 EST: 01:30 happens twice.
    const runs = nextRuns('30 1 * * *', local(2026, 10, 31, 12), 2).map(iso)
    expect(runs).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
    const hourly = nextRuns('0 * * * *', local(2026, 11, 1, 0, 30), 3).map(iso)
    expect(hourly).toEqual([
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ])
  })

  it('keeps wall-clock time across DST (daily 08:00 before and after)', () => {
    const runs = nextRuns('0 8 * * *', local(2026, 3, 7, 9), 2).map(iso)
    expect(runs).toEqual(['2026-03-08T12:00:00.000Z', '2026-03-09T12:00:00.000Z'])
  })
})

describe('validateRoutineCron', () => {
  it('accepts sane schedules and normalizes them', () => {
    expect(validateRoutineCron('  0  8 * *   1-5 ')).toBe('0 8 * * 1-5')
    expect(validateRoutineCron('*/5 * * * *')).toBe('*/5 * * * *')
  })
  it('rejects schedules that never run or run too often', () => {
    expect(() => validateRoutineCron('0 0 31 2 *')).toThrow(/never runs/)
    expect(() => validateRoutineCron('* * * * *')).toThrow(/too often/)
    expect(() => validateRoutineCron('0,2 8 * * *')).toThrow(/too often/)
  })
})

// Portuguese on purpose: these cases test the pt-BR phrase parser.
describe('parseSchedule', () => {
  const now = local(2026, 9, 26, 10)
  const cases: Array<[string, string]> = [
    ['todo dia 08:00', '0 8 * * *'],
    ['Todos os dias às 7h15', '15 7 * * *'],
    ['diariamente às 20h', '0 20 * * *'],
    ['às 8h', '0 8 * * *'],
    ['8 da noite todo dia', '0 20 * * *'],
    ['seg a sex 18:30', '30 18 * * 1-5'],
    ['de segunda a sexta às 18h30', '30 18 * * 1-5'],
    ['dias úteis 9h', '0 9 * * 1-5'],
    ['toda segunda 9h', '0 9 * * 1'],
    ['segunda-feira às 10:00', '0 10 * * 1'],
    ['seg, qua e sex às 7h', '0 7 * * 1,3,5'],
    ['sábados e domingos 10h', '0 10 * * 0,6'],
    ['fim de semana ao meio-dia', '0 12 * * 0,6'],
    ['todo dia 1º', '0 9 1 * *'],
    ['todo dia 1º às 08:00', '0 8 1 * *'],
    ['todo dia 15 às 10h', '0 10 15 * *'],
    ['dia 5 de cada mês 18h', '0 18 5 * *'],
    ['todo mês', '0 9 1 * *'],
    ['a cada 2 horas', '0 */2 * * *'],
    ['de 3 em 3 horas', '0 */3 * * *'],
    ['de hora em hora', '0 * * * *'],
    ['a cada 30 minutos', '*/30 * * * *'],
    ['every day at 8am', '0 8 * * *'],
    ['daily 08:00', '0 8 * * *'],
    ['weekdays 6:30pm', '30 18 * * 1-5'],
    ['every monday at 9', '0 9 * * 1'],
    ['mon, wed and fri at 9:15', '15 9 * * 1,3,5'],
    ['mon-fri 7am', '0 7 * * 1-5'],
    ['weekends at noon', '0 12 * * 0,6'],
    ['every month on the 1st at 8am', '0 8 1 * *'],
    ['monthly on the 15th', '0 9 15 * *'],
    ['every 2 hours', '0 */2 * * *'],
    ['every hour', '0 * * * *'],
    ['every 15 minutes', '*/15 * * * *'],
    ['at midnight every day', '0 0 * * *'],
    ['0 8 * * 1-5', '0 8 * * 1-5'],
    ['@weekly', '0 0 * * 0'],
  ]
  for (const [input, cron] of cases) {
    it(`"${input}" → ${cron}`, () => expect(parseSchedule(input, now)).toBe(cron))
  }

  it('explains what it could not understand, with examples', () => {
    expect(() => parseSchedule('quando der vontade', now)).toThrow(
      /Could not understand.*todo dia 08:00.*0 8 \* \* 1-5/,
    )
    expect(() => parseSchedule('', now)).toThrow(ScheduleError)
  })

  it('rejects intervals that are too short or do not divide the day', () => {
    expect(() => parseSchedule('a cada minuto', now)).toThrow(/at most every 5 minutes/)
    expect(() => parseSchedule('every 2 minutes', now)).toThrow(/at most every 5 minutes/)
    expect(() => parseSchedule('a cada 5 horas', now)).toThrow(/does not divide the day/)
    expect(() => parseSchedule('every 7 minutes', now)).toThrow(/does not divide the hour/)
    expect(() => parseSchedule('todo dia 31', now)).toThrow(/up to 28/)
    expect(() => parseSchedule('todo dia 25:00', now)).toThrow(/Invalid time/)
    expect(() => parseSchedule('* * * * *', now)).toThrow(/too often/)
  })
})

describe('shapes', () => {
  it('recognizes what the builder can edit and round-trips it', () => {
    const cases: Array<[string, ReturnType<typeof analyzeCron>]> = [
      ['0 8 * * *', { kind: 'daily', time: { hour: 8, minute: 0 } }],
      ['30 18 * * 1-5', { kind: 'weekly', days: [1, 2, 3, 4, 5], time: { hour: 18, minute: 30 } }],
      ['0 8 1 * *', { kind: 'monthly', day: 1, time: { hour: 8, minute: 0 } }],
      ['0 */2 * * *', { kind: 'hourly', every: 2, minute: 0 }],
      ['15 * * * *', { kind: 'hourly', every: 1, minute: 15 }],
      ['*/15 * * * *', { kind: 'minutes', every: 15 }],
    ]
    for (const [cron, shape] of cases) {
      expect(analyzeCron(cron)).toEqual(shape)
      expect(shapeToCron(shape)).toBe(cron)
    }
    expect(analyzeCron('0 8 1-7 * 1')).toEqual({ kind: 'custom', cron: '0 8 1-7 * 1' })
    expect(analyzeCron('0 8 * 1 *')).toEqual({ kind: 'custom', cron: '0 8 * 1 *' })
  })
})
