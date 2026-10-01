import type { RendererErrorReport } from '../../../bridge/contract'

const LIMITS = { message: 4_000, stack: 20_000, area: 100 }
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 20

const clip = (text: string | undefined, max: number) => (text === undefined ? undefined : text.slice(0, max))

/** A report of any thrown value, clipped to what the main process accepts. */
export function errorReport(
  source: RendererErrorReport['source'],
  error: unknown,
  extra: { area?: string; componentStack?: string | null } = {},
): RendererErrorReport {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const report: RendererErrorReport = { source, message: clip(message, LIMITS.message) ?? '' }
  const stack = error instanceof Error ? clip(error.stack, LIMITS.stack) : undefined
  if (stack) report.stack = stack
  if (extra.area) report.area = clip(extra.area, LIMITS.area)
  if (extra.componentStack) report.componentStack = clip(extra.componentStack, LIMITS.stack)
  return report
}

/** Drops repeats of a message within a minute and anything past MAX_PER_WINDOW a minute (render loops). */
export function reportLimiter(): (report: RendererErrorReport, now: number) => boolean {
  const recent = new Map<string, number>()
  let windowStart = 0
  let count = 0
  return (report, now) => {
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now
      count = 0
    }
    const key = `${report.source}\n${report.area ?? ''}\n${report.message}`
    const last = recent.get(key)
    if ((last !== undefined && now - last < WINDOW_MS) || count >= MAX_PER_WINDOW) return false
    recent.set(key, now)
    count++
    return true
  }
}

const allow = reportLimiter()

/** Sends a report to `<dataRoot>/logs/renderer.log` (through the main process). */
export function reportError(report: RendererErrorReport): void {
  if (allow(report, Date.now())) window.milibot?.reportRendererError(report)
}
