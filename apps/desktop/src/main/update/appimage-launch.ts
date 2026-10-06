import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

/**
 * Closes every descriptor above stderr, then runs its arguments with their output dropped (only a failure
 * to start them is reported). Bash, not sh: dash only redirects descriptors 0-9, and Electron holds higher
 * ones; the AppImage's own AppRun needs bash anyway.
 */
export const CLOSE_FDS_AND_EXEC =
  'for fd in $(ls /proc/$$/fd); do [ "$fd" -gt 2 ] && eval "exec $fd<&-"; done; ' +
  '[ -x "$1" ] || { echo "not executable: $1" >&2; exit 1; }; exec "$@" >/dev/null 2>&1'

/**
 * Starts `file` detached, without the descriptors this process holds; a failure to start it goes to `logFile`.
 * Node's spawn passes on those Chromium didn't mark close-on-exec, among them the AppImage runtime's
 * keep-alive pipe: an AppImage started with it (and the daemon it starts) would keep this one mounted, its
 * deleted file included, for as long as it runs.
 */
export function startDetachedClean(file: string, args: readonly string[], logFile: string): void {
  let out: number | 'ignore' = 'ignore'
  try {
    out = openSync(logFile, 'a')
  } catch {
    // Without the log the new version still starts.
  }
  try {
    const child = spawn('bash', ['-c', CLOSE_FDS_AND_EXEC, 'bash', file, ...args], {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    })
    child.on('error', (err) => console.error('[update] starting the new version failed', err))
    child.unref()
  } finally {
    if (typeof out === 'number') closeSync(out)
  }
}
