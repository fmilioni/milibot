import { describe, expect, it } from 'vitest'

import { describeScheduleEn, formatLocal } from '../../../src/runtime/routines/format'

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('formatLocal', () => {
  it('prints local date, time, weekday and zone', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(formatLocal(local(2026, 10, 1, 8, 5))).toBe(`2026-10-01 08:05 (Thu, ${zone})`)
    expect(formatLocal(null)).toBe('never')
  })
})

describe('describeScheduleEn', () => {
  it('describes schedules in English for the bots', () => {
    expect(describeScheduleEn('0 8 * * *')).toBe('every day at 08:00')
    expect(describeScheduleEn('30 18 * * 1-5')).toBe('Mon–Fri at 18:30')
    expect(describeScheduleEn('0 8 1 * *')).toBe('on the 1st of every month at 08:00')
    expect(describeScheduleEn('0 */2 * * *')).toBe('every 2 hours')
    expect(describeScheduleEn('0 8 * 1 *')).toBe('cron "0 8 * 1 *"')
  })
})
