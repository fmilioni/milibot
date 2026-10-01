import type { CliUsage, CliUsageWindow } from '@milibot/shared'

/** Command that prints the plan's quota as JSON (`command.data.groups[].buckets[]`). */
export const ANTIGRAVITY_USAGE_CMD = 'timeout 30 agy -p "/usage" --output-format json </dev/null'

interface Bucket {
  id?: unknown
  remaining_fraction?: unknown
  reset_time?: unknown
}

/**
 * Gemini's windows under the ids the app shows (`five_hour`, `seven_day`); the Claude/GPT group's keep agy's
 * own (`3p-5h`, `3p-weekly`).
 */
const WINDOW_IDS: Record<string, string> = { 'gemini-5h': 'five_hour', 'gemini-weekly': 'seven_day' }

/** The quota windows of `/usage` (one 5-hour and one weekly per model group); null when not that JSON. */
export function parseAntigravityUsage(stdout: string): CliUsageWindow[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf('{'))))
  } catch {
    return null
  }
  const data = (parsed as { status?: unknown; command?: { data?: { groups?: unknown } } } | null) ?? null
  if (data?.status !== 'SUCCESS' || !Array.isArray(data.command?.data?.groups)) return null
  const windows: CliUsageWindow[] = []
  for (const group of data.command.data.groups as Array<{ buckets?: unknown }>) {
    for (const bucket of Array.isArray(group.buckets) ? (group.buckets as Bucket[]) : []) {
      if (typeof bucket.id !== 'string' || typeof bucket.remaining_fraction !== 'number') continue
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : Number.NaN
      windows.push({
        id: WINDOW_IDS[bucket.id] ?? bucket.id,
        utilization: Math.min(1, Math.max(0, 1 - bucket.remaining_fraction)),
        resetsAt: Number.isFinite(reset) ? reset : null,
      })
    }
  }
  return windows
}

/**
 * The quota of an Antigravity provider (`CliUsage`) from the windows of its latest `/usage`. The limit is
 * Gemini's (the engine's models): a used-up Claude/GPT group only fails the turns of bots on those models.
 */
export function antigravityQuota(
  previous: CliUsage | null,
  providerId: string,
  windows: CliUsageWindow[],
  now: number,
): CliUsage {
  const full =
    windows.find(
      (w) =>
        Object.values(WINDOW_IDS).includes(w.id) &&
        w.utilization >= 1 &&
        (w.resetsAt === null || w.resetsAt > now),
    ) ?? null
  return {
    providerId,
    engine: 'antigravity',
    status: full ? 'rejected' : 'allowed',
    rateLimitType: full?.id ?? null,
    resetsAt: full?.resetsAt ?? null,
    windows,
    plan: previous?.plan ?? null,
    updatedAt: now,
  }
}
