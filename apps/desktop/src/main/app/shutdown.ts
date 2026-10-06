/**
 * What the app does when the system is about to end the session while it keeps the computer awake
 * (`active`, bots working):
 * - Windows (`query-session-end`): `block` puts the app in the list of apps keeping Windows from shutting
 *   down, where the user cancels or shuts down anyway. A critical end can't be blocked, and the installer
 *   closing the app (`close-app`) must not be.
 * - macOS (`powerMonitor` `shutdown`): `ask` cancels it and asks the user.
 * - Linux: nothing to ask with; the system only waits a few seconds for apps to exit.
 */
export type ShutdownDecision = 'allow' | 'block' | 'ask'

export function shutdownDecision(
  platform: NodeJS.Platform,
  active: boolean,
  reasons: readonly string[] = [],
): ShutdownDecision {
  if (!active) return 'allow'
  if (platform === 'win32')
    return reasons.includes('critical') || reasons.includes('close-app') ? 'allow' : 'block'
  if (platform === 'darwin') return 'ask'
  return 'allow'
}
