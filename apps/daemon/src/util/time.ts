/** Local calendar day as yyyy-mm-dd. */
export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local midnight of the day of `at`, or of `daysBack` days before it. */
export function startOfLocalDay(at: number, daysBack = 0): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysBack)
  return d.getTime()
}
