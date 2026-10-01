import {
  type BotLimits,
  DEFAULT_WORKSPACE_PREFERENCES,
  PREFERENCE_SETTING_KEYS,
  WorkspacePreferences,
} from '@milibot/shared'

const PARSED_PREFERENCES = Object.keys(PREFERENCE_SETTING_KEYS) as Array<keyof WorkspacePreferences>

/** Current preferences; an invalid or missing setting falls back to the default. */
export function readPreferences(get: <T>(key: string, fallback: T) => T): WorkspacePreferences {
  const result = { ...DEFAULT_WORKSPACE_PREFERENCES } as Record<string, unknown>
  for (const key of PARSED_PREFERENCES) {
    const raw = get<unknown>(PREFERENCE_SETTING_KEYS[key], undefined)
    if (raw === undefined) continue
    const parsed = WorkspacePreferences.shape[key].safeParse(raw)
    if (parsed.success) result[key] = parsed.data
  }
  return result as WorkspacePreferences
}

/** Limits of each bot's slice in the VM, or null when per-bot limits are off. */
export function botSliceLimits(preferences: WorkspacePreferences): BotLimits | null {
  if (!preferences.perBotLimits) return null
  return { cpuPercent: preferences.perBotCpuPercent, memoryMb: preferences.perBotMemoryGb * 1024 }
}

/** Whether an approved plan may merge its pull request: its own switch, else the workspace preference. */
export function planMergeAllowed(plan: { mergePr: boolean | null }, autoMergePrs: boolean): boolean {
  return plan.mergePr ?? autoMergePrs
}
