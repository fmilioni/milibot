import type { CliErrorCode } from '@milibot/shared'

/** Label prefix of the Antigravity CLI's processes in the VM. */
export const ANTIGRAVITY_PROC_LABEL = 'agy'

/** How `agy` words a missing or expired sign-in (it waits for one in print mode, then gives up). */
const LOGIN_REQUIRED =
  /authentication required|authentication failed|not signed in|unauthenticated|sign[- ]in/i
/**
 * The plan's caps (5-hour, weekly, credits). A bare `RESOURCE_EXHAUSTED` (429) is the server's capacity, which
 * agy already retried: an error, not the user's limit.
 */
const USAGE_LIMIT =
  /quota (?:exceeded|exhausted|reached)|usage limit|limit (?:reached|exceeded)|(?:weekly|five[- ]hour) limit|credits? (?:depleted|exhausted)/i

/** Error card code of a failed Antigravity turn (the app translates it and offers the login when it applies). */
export function antigravityErrorCode(message: string): CliErrorCode {
  if (LOGIN_REQUIRED.test(message)) return 'cli_login_required'
  if (USAGE_LIMIT.test(message)) return 'cli_usage_limit'
  return 'cli_error'
}
