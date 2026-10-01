import type { CliUsage, CliUsageWindow } from '@milibot/shared'
import type { TFunction } from 'i18next'

import { formatClock } from '@/lib/format'

const HOUR = 3_600_000

/** Windows shown in the footer, in order, with their length. */
const USAGE_WINDOWS = [
  { id: 'five_hour', label: '5h', durationMs: 5 * HOUR },
  { id: 'seven_day', label: '7d', durationMs: 7 * 24 * HOUR },
] as const

export type UsageTone = 'success' | 'warning' | 'danger'

/**
 * Share of the window already elapsed (0..1): at an even pace, usage would be exactly here.
 * Null without a reset time.
 */
export function pacing(resetsAt: number | null, durationMs: number, now: number): number | null {
  if (resetsAt === null) return null
  return Math.min(1, Math.max(0, 1 - (resetsAt - now) / durationMs))
}

/** Green at or under the pace, yellow up to 10 points above it, red beyond (or when limited). */
export function usageTone(utilization: number, pace: number | null, limited = false): UsageTone {
  if (limited) return 'danger'
  if (pace === null) return utilization < 0.5 ? 'success' : utilization < 0.8 ? 'warning' : 'danger'
  if (utilization <= pace) return 'success'
  if (utilization <= pace + 0.1) return 'warning'
  return 'danger'
}

/** `allowed` and `allowed_warning` still run; anything else means the limit was reached. */
export function isLimited(usage: CliUsage): boolean {
  return !usage.status.startsWith('allowed')
}

export interface UsageBar {
  id: string
  label: string
  utilization: number
  pace: number | null
  tone: UsageTone
  resetsAt: number | null
}

export function usageBars(usage: CliUsage, now: number): UsageBar[] {
  const limited = isLimited(usage)
  return USAGE_WINDOWS.flatMap((w) => {
    const window: CliUsageWindow | undefined = usage.windows.find((x) => x.id === w.id)
    if (!window) return []
    const pace = pacing(window.resetsAt, w.durationMs, now)
    const utilization = Math.min(1, Math.max(0, window.utilization))
    const limiting = limited && (usage.rateLimitType === null || usage.rateLimitType === w.id)
    return [
      {
        id: w.id,
        label: w.label,
        utilization,
        pace,
        tone: usageTone(utilization, pace, limiting),
        resetsAt: window.resetsAt,
      },
    ]
  })
}

export type PaceStatus = { kind: 'on_pace' } | { kind: 'above'; points: number }

/** Where usage stands against the even pace; null without a pace (no reset time). */
export function paceStatus(bar: Pick<UsageBar, 'utilization' | 'pace'>): PaceStatus | null {
  if (bar.pace === null) return null
  if (bar.utilization <= bar.pace) return { kind: 'on_pace' }
  return { kind: 'above', points: Math.max(1, Math.round((bar.utilization - bar.pace) * 100)) }
}

export interface UsageTooltipText {
  title: string
  details: string[]
  renews: string | null
}

/** "5-hour window" / "12% used · ideal pace 34%" / "Renews at 21:00" (weekly: "Renews Fri, 14:00"). */
export function usageTooltipText(bar: UsageBar, t: TFunction, locale: string): UsageTooltipText {
  const details = [t('footer.quota.used', { percent: Math.round(bar.utilization * 100) })]
  if (bar.pace !== null) details.push(t('footer.quota.pace', { percent: Math.round(bar.pace * 100) }))
  let renews: string | null = null
  if (bar.resetsAt !== null) {
    const time = formatClock(bar.resetsAt, locale)
    renews =
      bar.id === 'five_hour'
        ? t('footer.quota.renewsAt', { time })
        : t('footer.quota.renewsOn', {
            day: new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(bar.resetsAt),
            time,
          })
  }
  return { title: t(`footer.quota.windowTitles.${bar.id}`, { defaultValue: bar.label }), details, renews }
}

const PLAN_NAMES: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
  api: 'API',
}

/** Product name of the connected account's plan; null hides the badge. */
export function planLabel(plan: string | null | undefined): string | null {
  const key = plan?.trim().toLowerCase()
  if (!key) return null
  return PLAN_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}
