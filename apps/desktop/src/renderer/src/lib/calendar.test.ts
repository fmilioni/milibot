import { describe, expect, it } from 'vitest'

import { addDays, addMonths, formatDueDate, monthGrid, parseIsoDay, weekStart } from './calendar'

describe('calendar', () => {
  it('builds six weeks from the locale week start', () => {
    const sunday = monthGrid(2026, 8, 0)
    expect(sunday).toHaveLength(42)
    expect(sunday[0]).toBe('2026-08-30')
    expect(sunday[2]).toBe('2026-09-01')
    const monday = monthGrid(2026, 8, 1)
    expect(monday[0]).toBe('2026-08-31')
    expect(monday[1]).toBe('2026-09-01')
  })

  it('moves by days and months across edges', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15')
    expect(parseIsoDay('nope')).toBeNull()
  })

  it('reads the week start of a locale', () => {
    expect(weekStart('pt-BR')).toBe(0)
    expect([0, 1]).toContain(weekStart('en'))
  })

  it('shows due dates short, with the year only when it is another year', () => {
    expect(formatDueDate('2026-10-10', 'en', '2026-09-29')).toBe('Oct 10')
    expect(formatDueDate('2027-01-02', 'en', '2026-09-29')).toBe('Jan 2, 2027')
    expect(formatDueDate('2026-10-10', 'pt-BR', '2026-09-29')).toBe('10 out')
  })
})
