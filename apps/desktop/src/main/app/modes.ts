import { app } from 'electron'

import type { DaemonManager } from '../daemon/manager'
import { START_DAEMON_FLAG, STOP_DAEMON_FLAG } from '../platform/app-id'

export type LaunchMode = 'start-daemon' | 'stop-daemon' | 'app'

/**
 * Login items and the installer run the app with a flag: it only starts or stops the daemon and exits
 * without any window, skipping the single-instance lock so an open app is left alone.
 */
export function launchMode(argv: readonly string[]): LaunchMode {
  if (argv.includes(START_DAEMON_FLAG)) return 'start-daemon'
  if (argv.includes(STOP_DAEMON_FLAG)) return 'stop-daemon'
  return 'app'
}

export function runDaemonMode(mode: Exclude<LaunchMode, 'app'>, daemon: DaemonManager): void {
  const work =
    mode === 'start-daemon'
      ? daemon.ensure().catch((err: unknown) => console.error('[main] daemon not started at login', err))
      : daemon.stop().catch((err: unknown) => console.error('[main] daemon not stopped', err))
  void work.finally(() => app.exit(0))
}
