import { CLI_ENGINE_INFO, type CliEngine } from '@milibot/shared'

/** What the texts about a CLI engine interpolate: `{{engine}}`, `{{account}}`, `{{vendor}}`, `{{option}}`. */
export function cliTextParams(engine: CliEngine) {
  const info = CLI_ENGINE_INFO[engine]
  return { engine: info.displayName, account: info.account, vendor: info.vendor, option: info.loginOption }
}
