import type { CostDay } from '@milibot/shared'

export interface CostBar extends CostDay {
  /** Height relative to the most expensive day (0–100). */
  heightPct: number
  /** The last day of the series is today. */
  today: boolean
}

/** Bars of the "Cost per day" chart; an idle period renders as a flat baseline. */
export function costBars(days: CostDay[]): CostBar[] {
  const max = Math.max(0, ...days.map((d) => d.costUsd))
  return days.map((d, i) => ({
    ...d,
    heightPct: max > 0 ? (d.costUsd / max) * 100 : 0,
    today: i === days.length - 1,
  }))
}
