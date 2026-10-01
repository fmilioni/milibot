import { CLI_ENGINES, type CliEngine } from '@milibot/shared'

import { antigravityDriver } from '../antigravity'
import { claudeCodeDriver } from '../claude-code'
import { codexDriver } from '../codex'
import type { CliEngineDriver } from './engine'

/** Every CLI engine's driver: the only place that names the engine folders. */
export const CLI_ENGINE_DRIVERS: Record<CliEngine, CliEngineDriver> = {
  claude_code: claudeCodeDriver,
  codex: codexDriver,
  antigravity: antigravityDriver,
}

/** Prefixes of the labels the CLI engines give their processes in the VM (lanes and one-shots). */
export const CLI_PROC_LABEL_PREFIXES: Record<CliEngine, readonly string[]> = Object.fromEntries(
  CLI_ENGINES.map((engine): [CliEngine, readonly string[]] => {
    const label = CLI_ENGINE_DRIVERS[engine].procLabel
    return [engine, [`${label}:`, `${label}-`]]
  }),
) as Record<CliEngine, readonly string[]>
