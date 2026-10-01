import type { CliUsage, CliUsageWindow } from '@milibot/shared'

import type { RateLimitSnapshot, RateLimitWindow } from './protocol'

const WINDOW_IDS: Record<number, string> = { 300: 'five_hour', 10_080: 'seven_day' }

function windowId(window: RateLimitWindow, fallback: string): string {
  return window.windowDurationMins === null
    ? fallback
    : (WINDOW_IDS[window.windowDurationMins] ?? `${window.windowDurationMins}m`)
}

/**
 * The subscription quota of a Codex provider in the shape the app shows (`CliUsage`), from the latest
 * `account/rateLimits/updated`. Updates are sparse: a window the snapshot leaves null keeps its last value.
 */
export function mergeCodexRateLimits(
  previous: CliUsage | null,
  providerId: string,
  snapshot: RateLimitSnapshot,
  now: number,
): CliUsage | null {
  const updates = (
    [
      [snapshot.primary, 'primary'],
      [snapshot.secondary, 'secondary'],
    ] as const
  ).flatMap(([window, fallback]) =>
    window
      ? [
          {
            id: windowId(window, fallback),
            utilization: Math.max(0, window.usedPercent) / 100,
            resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
          } satisfies CliUsageWindow,
        ]
      : [],
  )
  if (!updates.length && !snapshot.planType && !snapshot.rateLimitReachedType && !previous) return null
  const windows = new Map((previous?.windows ?? []).map((w) => [w.id, w]))
  for (const w of updates) windows.set(w.id, w)
  const list = [...windows.values()]
  const full = list.find((w) => w.utilization >= 1 && (w.resetsAt === null || w.resetsAt > now)) ?? null
  const limited = full !== null || snapshot.rateLimitReachedType !== null
  return {
    providerId,
    engine: 'codex',
    status: limited ? 'rejected' : 'allowed',
    rateLimitType: full?.id ?? null,
    resetsAt: full?.resetsAt ?? null,
    windows: list,
    plan: snapshot.planType ?? previous?.plan ?? null,
    updatedAt: now,
  }
}
