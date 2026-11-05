import { CLI_ENGINE_INFO, CLI_ENGINES, type CliEngine } from '@milibot/shared'

/** What the texts about a CLI engine interpolate: `{{engine}}`, `{{account}}`, `{{vendor}}`, `{{option}}`. */
export function cliTextParams(engine: CliEngine) {
  const info = CLI_ENGINE_INFO[engine]
  return { engine: info.displayName, account: info.account, vendor: info.vendor, option: info.loginOption }
}

/** Every engine's brand name in one list ("Claude Code, Codex and Antigravity"). */
export function cliEngineNames(language: string): string {
  const names = CLI_ENGINES.map((engine) => CLI_ENGINE_INFO[engine].displayName)
  return new Intl.ListFormat(language, { type: 'conjunction' }).format(names)
}
