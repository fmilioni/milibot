/** Dates here are local calendar days as `YYYY-MM-DD` (the board due-date format). */

function isoDay(year: number, month: number, day: number): string {
  const d = new Date(year, month, day)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function parseIsoDay(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) }
}

export function addDays(value: string, days: number): string {
  const p = parseIsoDay(value)
  return p ? isoDay(p.year, p.month, p.day + days) : value
}

/** Same day of another month, clamped to that month's length (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(value: string, months: number): string {
  const p = parseIsoDay(value)
  if (!p) return value
  const last = new Date(p.year, p.month + months + 1, 0).getDate()
  return isoDay(p.year, p.month + months, Math.min(p.day, last))
}

/** First day of the week for a locale, 0 = Sunday … 6 = Saturday (Sunday when the runtime can't tell). */
export function weekStart(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay
    return firstDay ? firstDay % 7 : 0
  } catch {
    return 0
  }
}

/** Six weeks of days covering `month`, starting on `firstDay`. */
export function monthGrid(year: number, month: number, firstDay: number): string[] {
  const offset = (new Date(year, month, 1).getDay() - firstDay + 7) % 7
  return Array.from({ length: 42 }, (_, i) => isoDay(year, month, 1 - offset + i))
}

/** "10 Oct" (with the year when it is not this year's). */
export function formatDueDate(date: string, locale: string, today: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const value = new Date(year, month - 1, day)
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  })
    .format(value)
    .replace(/\.$/, '')
    .replace(' de ', ' ')
}
