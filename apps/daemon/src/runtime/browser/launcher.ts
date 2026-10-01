import { CDP_PORT_BASE } from '@milibot/shared'

import { parseKeyValueLines } from '../vm'

/** DevTools port of a bot's Chrome inside the VM (same rule as `vm/guest/bin/milibot-browser`). */
export function cdpPort(displayNum: number): number {
  return CDP_PORT_BASE + displayNum
}

/**
 * `scripts/ensure-browser.sh`, run as root: makes sure the bot's Chrome (`/usr/local/bin/milibot-browser`,
 * installed by the guest agent) listens on its DevTools port. A Chrome started without the port (older
 * launcher) is closed gracefully and reopened with its tabs (`--restore-last-session`). Chrome runs as a
 * transient systemd service in the bot's slice, so it outlives the request and a guest agent restart. Env:
 * `SLUG`, `PORT`, `DISPLAY_NUM`; prints `STATE=ready|started` (+ `RESTARTED=1`).
 */
export { ENSURE_BROWSER_SCRIPT } from './scripts/ensure-browser.generated'

export function parseEnsureOutput(stdout: string): { state: string; restarted: boolean } {
  const values = parseKeyValueLines(stdout)
  return { state: values.STATE ?? 'unknown', restarted: values.RESTARTED === '1' }
}
