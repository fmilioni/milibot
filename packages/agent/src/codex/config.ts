import type { CliErrorCode } from '@milibot/shared'

import type { CodexErrorInfo } from './protocol'

/** Label prefix of Codex's processes in the VM. */
export const CODEX_PROC_LABEL = 'codex'

function httpStatus(info: CodexErrorInfo | null): number | null {
  if (!info || typeof info !== 'object') return null
  const inner = Object.values(info)[0] as { httpStatusCode?: number | null } | undefined
  return inner?.httpStatusCode ?? null
}

/** Error card code of a failed Codex turn (the app translates it and offers the login when it applies). */
export function codexErrorCode(info: CodexErrorInfo | null, message: string): CliErrorCode {
  if (info === 'unauthorized' || httpStatus(info) === 401) return 'cli_login_required'
  if (/not logged in|codex login|authentication required/i.test(message)) return 'cli_login_required'
  if (info === 'usageLimitExceeded') return 'cli_usage_limit'
  return 'cli_error'
}
