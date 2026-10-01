import { CLI_ENGINE_INFO, type CliEngine, cliSettingKeys, type CliSettings } from '@milibot/shared'

import { cliKeys } from './keys'

export type GetSetting = <T>(key: string, fallback: T) => T

/** When a lane's stored CLI session is replaced by a fresh one (see `rotationReason`). */
export interface CliRotationSettings {
  rotateIdleMinutes: number
  rotateContextTokens: number
}

/**
 * The engines' prompt cache lives about 1 h (Claude Code's: exactly); rotating a bit before avoids rewriting a
 * cold context, and a lean fresh session with Milibot's memory beats rereading a big one.
 */
const DEFAULT_ROTATION: CliRotationSettings = { rotateIdleMinutes: 55, rotateContextTokens: 60_000 }

/** A positive number setting, floored; `fallback` when unset or invalid. */
function settingInt(get: GetSetting, key: string, fallback: number): number {
  const value = get<unknown>(key, fallback)
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export function cliRotationSettings(engine: CliEngine, get: GetSetting): CliRotationSettings {
  const keys = cliKeys(engine)
  return {
    rotateIdleMinutes: settingInt(get, keys.rotateIdleMinutes, DEFAULT_ROTATION.rotateIdleMinutes),
    rotateContextTokens: settingInt(get, keys.rotateContextTokens, DEFAULT_ROTATION.rotateContextTokens),
  }
}

/** The engine's settings as the app edits them (`compactSystemPrompt` only where the engine has it). */
export function cliUserSettings(engine: CliEngine, get: GetSetting): CliSettings {
  const rotation = cliRotationSettings(engine, get)
  if (!CLI_ENGINE_INFO[engine].compactSystemPrompt) return rotation
  const compact = get<unknown>(cliSettingKeys(engine).compactSystemPrompt, true)
  return { ...rotation, compactSystemPrompt: typeof compact === 'boolean' ? compact : true }
}
