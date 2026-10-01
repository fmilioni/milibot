import { START_DAEMON_FLAG } from '../app-id'
import { type CommandRunner, commandRunner } from '../exec'
import type { LoginItem } from './index'

/**
 * The "start in the background at login" setting on Windows: a value in the user's
 * `Run` key. It starts the app with `--start-daemon`, which only makes sure the daemon is running and
 * exits (no window, no tray): the Run key has no place for the daemon's environment or log file, and
 * the app already knows how to start it.
 */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const RUN_VALUE = 'Milibot'

/** The `Run` key values the login item uses (injected: tests never touch the real registry). */
export interface RunKey {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  remove(name: string): Promise<void>
}

export interface RunKeyDeps {
  runKey: RunKey
  /** The app's executable (`process.execPath`). */
  executable: string
  /** Dev (not packaged): Electron needs the app folder before the flag. */
  appPath: string | null
}

/** One argument quoted for the Windows command line (`CommandLineToArgvW` rules). */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let quoted = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') {
      backslashes++
      continue
    }
    if (char === '"') quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    else quoted += '\\'.repeat(backslashes) + char
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** The command line written to the `Run` value. The executable is always quoted (paths with spaces). */
export function runCommand(deps: Pick<RunKeyDeps, 'executable' | 'appPath'>): string {
  const args = [...(deps.appPath ? [deps.appPath] : []), START_DAEMON_FLAG]
  return [`"${deps.executable}"`, ...args.map(quoteWindowsArg)].join(' ')
}

export async function runKeyEnabled(deps: RunKeyDeps): Promise<boolean> {
  return (await deps.runKey.get(RUN_VALUE)) !== null
}

/** On: writes the value. Off: removes it (never stops the daemon the bots are using). */
export async function setRunKey(enabled: boolean, deps: RunKeyDeps): Promise<boolean> {
  if (enabled) {
    const command = runCommand(deps)
    if ((await deps.runKey.get(RUN_VALUE)) !== command) await deps.runKey.set(RUN_VALUE, command)
    return true
  }
  await deps.runKey.remove(RUN_VALUE)
  return false
}

/** Keeps an installed value pointing at this copy of the app (moved or updated). */
export async function refreshRunKey(deps: RunKeyDeps): Promise<boolean> {
  const current = await deps.runKey.get(RUN_VALUE)
  const command = runCommand(deps)
  if (current === null || current === command) return false
  await deps.runKey.set(RUN_VALUE, command)
  return true
}

/** `    Milibot    REG_SZ    "C:\…\Milibot.exe" --start-daemon` in `reg query` output. */
export function parseRegQuery(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line)
    if (match && match[1]!.toLowerCase() === name.toLowerCase()) return match[3]!
  }
  return null
}

/** The real `Run` key through `reg.exe` (exit code 1 on query/delete = the value does not exist). */
export function regRunKey(reg: CommandRunner = commandRunner('reg.exe')): RunKey {
  return {
    get: async (name) => {
      const result = await reg(['query', RUN_KEY, '/v', name])
      return result.code === 0 ? parseRegQuery(result.stdout, name) : null
    },
    set: async (name, value) => {
      const result = await reg(['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'])
      if (result.code !== 0) throw new Error(`reg add failed (${result.code})`)
    },
    remove: async (name) => {
      if ((await reg(['query', RUN_KEY, '/v', name])).code !== 0) return
      const result = await reg(['delete', RUN_KEY, '/v', name, '/f'])
      if (result.code !== 0) throw new Error(`reg delete failed (${result.code})`)
    },
  }
}

export function runKeyLoginItem(deps: RunKeyDeps): LoginItem {
  return {
    supported: true,
    enabled: () => runKeyEnabled(deps),
    set: (enabled) => setRunKey(enabled, deps),
    refresh: () => refreshRunKey(deps),
  }
}
