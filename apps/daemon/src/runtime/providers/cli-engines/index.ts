import { type CliEngine, isCliEngine } from '@milibot/shared'

import { antigravityHost } from './antigravity'
import { claudeCodeHost } from './claude-code'
import { codexHost } from './codex'
import type { CliEngineHost } from './host'

export const CLI_ENGINE_HOSTS: Record<CliEngine, CliEngineHost> = {
  claude_code: claudeCodeHost,
  codex: codexHost,
  antigravity: antigravityHost,
}

/** The host of a provider type that runs as a CLI engine, else null. */
export function cliEngineHost(type: string | null | undefined): CliEngineHost | null {
  return isCliEngine(type) ? CLI_ENGINE_HOSTS[type] : null
}
