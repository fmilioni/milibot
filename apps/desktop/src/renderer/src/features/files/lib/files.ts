/** Day buckets of the files list: today, yesterday, the last 7 days, then one per calendar month. */
export type FileGroupKey = 'today' | 'yesterday' | 'week' | `month:${number}-${number}`

const DAY = 86_400_000

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function fileGroup(ts: number, now: number): FileGroupKey {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return 'week'
  const date = new Date(ts)
  return `month:${date.getFullYear()}-${date.getMonth() + 1}`
}

/** Consecutive runs of items (newest first) in the same bucket. */
export function groupFiles<T extends { createdAt: number }>(
  items: T[],
  now: number,
): Array<{ key: FileGroupKey; items: T[] }> {
  const groups: Array<{ key: FileGroupKey; items: T[] }> = []
  for (const item of items) {
    const key = fileGroup(item.createdAt, now)
    const last = groups.at(-1)
    if (last?.key === key) last.items.push(item)
    else groups.push({ key, items: [item] })
  }
  return groups
}

/** Month and year in `locale` for a month bucket; null for the named ones (translated by the caller). */
export function monthLabel(key: FileGroupKey, locale: string): string | null {
  if (!key.startsWith('month:')) return null
  const [year, month] = key.slice('month:'.length).split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(year as number, (month as number) - 1, 1),
  )
}

/** The VM folder of a file (its path without the name). */
export function vmFolder(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : path
}
