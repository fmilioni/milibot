import type { TFunction } from 'i18next'

const MINUTE = 60_000
const DAY = 86_400_000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Compact timestamp for sidebar rows: "now", "14:02", "yesterday", "Mon", "12/09". */
export function formatListTime(ts: number, locale: string, t: TFunction, now = Date.now()): string {
  if (now - ts < MINUTE) return t('time.now')
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY)
  if (days === 0) return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ts)
  if (days === 1) return t('time.yesterday')
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(ts).replace('.', '')
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(ts)
}

/** "14:02", or "14:02:37" with `seconds`. */
export function formatClock(ts: number, locale: string, { seconds = false } = {}): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  }).format(ts)
}

export function formatDay(ts: number, locale: string, t: TFunction, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY)
  if (days === 0) return t('time.today')
  if (days === 1) return t('time.yesterdayTitle')
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(ts)
}

/**
 * `cents`: "$1.20"; `cost`: three decimals below one dollar ("$0.031", "$1.84"); `price`: up to four
 * decimals for sub-cent prices per million tokens ("$0.005").
 */
export function formatUsd(
  value: number,
  locale: string,
  precision: 'cents' | 'cost' | 'price' = 'cents',
): string {
  const digits = precision === 'cost' && Math.abs(value) < 1 ? 3 : 2
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: precision === 'price' && value > 0 && value < 0.01 ? 4 : digits,
  }).format(value)
}

/** Spelled-out compact count: "12 mil" in pt-BR, "12K" in English. */
export function formatTokens(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/** "312", "18,4k", "132k", "2,5M" with the decimal separator of the locale. */
export function compactTokens(value: number, locale: string): string {
  const n = Math.round(value)
  if (n < 1000) return String(n)
  const [scaled, suffix] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'M']
  const digits = scaled < 100 ? 1 : 0
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(scaled)}${suffix}`
}

const KB = 1024
const GB = KB ** 3

/** "512 B", "1,5 KB", "850 MB", "1,2 GB". */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= KB && unit < units.length - 1) {
    value /= KB
    unit++
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`
}

/** Gigabytes without the unit ("1,2", "40"), for texts that place "GB" themselves. */
export function formatGb(bytes: number, locale: string): string {
  const gb = bytes / GB
  return new Intl.NumberFormat(locale, { maximumFractionDigits: gb < 10 ? 1 : 0 }).format(gb)
}

/** "0,9s", "28s", "2min 5s". */
export function formatDuration(ms: number, locale: string): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(seconds)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}min ${Math.round(seconds - minutes * 60)}s`
}

/** Stopwatch time: "02:14"; negative (a start after a stale `now`) shows as "00:00". */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** "2 days ago", "yesterday", "3 hours ago"; `justNow` replaces anything under a minute. */
export function formatRelative(ts: number, locale: string, now = Date.now(), justNow?: string): string {
  if (justNow !== undefined && Math.abs(now - ts) < MINUTE) return justNow
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const seconds = Math.round((ts - now) / 1000)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 86_400],
    ['month', 30 * 86_400],
    ['week', 7 * 86_400],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  return format.format(0, 'minute')
}
