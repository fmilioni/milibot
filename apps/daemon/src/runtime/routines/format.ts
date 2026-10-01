import { localStamp } from '@milibot/agent'
import { analyzeCron, formatTimeOfDay } from '@milibot/shared'

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}

/** English description for bots (tool results); the app renders its own localized label. */
export function describeScheduleEn(cron: string): string {
  const shape = analyzeCron(cron)
  switch (shape.kind) {
    case 'daily':
      return `every day at ${formatTimeOfDay(shape.time)}`
    case 'weekly': {
      const days = sameDays(shape.days, [1, 2, 3, 4, 5])
        ? 'Mon–Fri'
        : sameDays(shape.days, [0, 6])
          ? 'Sat and Sun'
          : shape.days.map((d) => EN_DAYS[d]).join(', ')
      return `${days} at ${formatTimeOfDay(shape.time)}`
    }
    case 'monthly':
      return `on the ${ordinal(shape.day)} of every month at ${formatTimeOfDay(shape.time)}`
    case 'hourly':
      return shape.every === 1
        ? `every hour at minute ${shape.minute}`
        : `every ${shape.every} hours${shape.minute ? ` at minute ${shape.minute}` : ''}`
    case 'minutes':
      return `every ${shape.every} minutes`
    case 'custom':
      return `cron "${shape.cron}"`
  }
}

/** Local date and time for the bots ("2026-10-01 08:00 (Thu, America/Sao_Paulo)"). */
export function formatLocal(at: number | null): string {
  if (at === null) return 'never'
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${localStamp(at)} (${EN_DAYS[new Date(at).getDay()]}, ${zone})`
}
