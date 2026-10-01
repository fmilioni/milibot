import type { CliErrorCode, CliSettings } from '@milibot/shared'

import { cliUserSettings, type GetSetting } from '../cli/settings'

/** Label prefix of Claude Code's processes in the VM. */
export const CLAUDE_CODE_PROC_LABEL = 'claude'

export function claudeCodeSettings(getSetting: GetSetting): Required<CliSettings> {
  const settings = cliUserSettings('claude_code', getSetting)
  return { ...settings, compactSystemPrompt: settings.compactSystemPrompt ?? true }
}

const LOGIN_REQUIRED = /not logged in|\/login|invalid api key/i
/** How Claude Code words a refused subscription request ("Claude AI usage limit reached", "You've hit your limit"). */
const USAGE_LIMIT = /usage limit|limit reached|hit your limit/i

/** Error card code of a failed Claude Code turn (the app translates it and offers the login when it applies). */
export function claudeCodeErrorCode(message: string, rateLimited: boolean): CliErrorCode {
  if (LOGIN_REQUIRED.test(message)) return 'cli_login_required'
  if (rateLimited || USAGE_LIMIT.test(message)) return 'cli_usage_limit'
  return 'cli_error'
}
