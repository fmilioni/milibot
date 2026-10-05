import { DEFAULT_WORKSPACE_PREFERENCES, IdleWatchFallback, PREFERENCE_SETTING_KEYS } from '@milibot/shared'

import { cliKeys } from '../cli/keys'
import type { HostStateStore } from '../environment'

type GetSetting = <T>(key: string, fallback: T) => T

/** Workspace settings the agent host reads (besides the memory and CLI engine ones). */
const AGENT_SETTING_KEYS = {
  maxParallel: PREFERENCE_SETTING_KEYS.maxParallelBots,
  /** Work session lanes running at once (default: one less than `maxParallel`). */
  maxParallelSessions: 'agents.max_parallel_sessions',
} as const

/** Settings the host writes for itself (not user preferences; the CLI engines' are `cliKeys`). */
const HOST_STATE_KEYS = {
  /** The user paused the bot; kept across runtime restarts. */
  paused: (botId: string) => `bot.paused.${botId}`,
} as const

/** The host's state kept in workspace settings, under keys stored data depends on. */
export function settingsHostState(store: {
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
}): HostStateStore {
  return {
    paused: (botId) => store.getSetting<boolean>(HOST_STATE_KEYS.paused(botId), false) === true,
    setPaused: (botId, paused) => store.setSetting(HOST_STATE_KEYS.paused(botId), paused),
    cliMeta: (engine, laneKey) => store.getSetting(cliKeys(engine).meta(laneKey), null),
    setCliMeta: (engine, laneKey, meta) => store.setSetting(cliKeys(engine).meta(laneKey), meta),
    cliBootstrap: (engine, laneKey) => store.getSetting(cliKeys(engine).bootstrap(laneKey), null),
    setCliBootstrap: (engine, laneKey, bootstrap) =>
      store.setSetting(cliKeys(engine).bootstrap(laneKey), bootstrap),
  }
}

const DEFAULT_MAX_PARALLEL = 3

/** `value` when it is a positive integer, else null. */
export function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** Accessors read on every call, so a changed setting applies to the next decision. */
export function agentSettings(getSetting: GetSetting) {
  const maxParallel = () =>
    positiveInt(getSetting<unknown>(AGENT_SETTING_KEYS.maxParallel, null)) ?? DEFAULT_MAX_PARALLEL
  return {
    maxParallel,
    maxParallelSessions: () =>
      positiveInt(getSetting<unknown>(AGENT_SETTING_KEYS.maxParallelSessions, null)) ??
      Math.max(1, maxParallel() - 1),
    /** 0 = the idle watch is off. */
    idleWatchMinutes: () => {
      const value = getSetting<unknown>(PREFERENCE_SETTING_KEYS.idleWatchMinutes, null)
      return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : DEFAULT_WORKSPACE_PREFERENCES.idleWatchMinutes
    },
    idleWatchBotId: () => {
      const value = getSetting<unknown>(PREFERENCE_SETTING_KEYS.idleWatchBotId, null)
      return typeof value === 'string' && value ? value : null
    },
    idleWatchFallback: (): IdleWatchFallback => {
      const parsed = IdleWatchFallback.safeParse(
        getSetting<unknown>(PREFERENCE_SETTING_KEYS.idleWatchFallback, null),
      )
      return parsed.success ? parsed.data : DEFAULT_WORKSPACE_PREFERENCES.idleWatchFallback
    },
  }
}

export type AgentSettings = ReturnType<typeof agentSettings>
