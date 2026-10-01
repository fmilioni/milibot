import { join } from 'node:path'

import { DATA_DIR_ENV } from '@milibot/shared'

import type { DaemonCommand } from '../../daemon/command'
import { START_DAEMON_FLAG } from '../app-id'
import { shellQuote } from '../exec'
import type { LoginItem } from './index'

/**
 * The "start in the background at login" setting on Linux: an XDG autostart entry
 * (`$XDG_CONFIG_HOME/autostart/milibot-daemon.desktop`) that starts milibotd when the desktop session
 * starts. Simpler than a systemd user unit and it works without systemd.
 */
export const AUTOSTART_FILE = 'milibot-daemon.desktop'

/** The filesystem calls the autostart entry needs (injected: tests never touch the real one). */
export interface AutostartFs {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, content: string): void
  mkdir(path: string): void
  remove(path: string): void
}

export interface AutostartDeps {
  /** Full path of the `.desktop` file. */
  file: string
  /** The same command the app uses to spawn the daemon. */
  command: () => DaemonCommand
  logFile: string
  fs: AutostartFs
}

/** `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart` when it is unset or not absolute (per the spec). */
export function autostartDir(env: NodeJS.ProcessEnv, home: string): string {
  const config = env.XDG_CONFIG_HOME
  return join(config && config.startsWith('/') ? config : join(home, '.config'), 'autostart')
}

/**
 * An AppImage runs from a mount that changes at every launch, so its entry starts the AppImage file
 * itself with `--start-daemon` (the app then spawns the daemon and exits).
 */
export function appImageCommand(appImage: string, dataRoot: string): DaemonCommand {
  return { command: appImage, args: [START_DAEMON_FLAG], env: { [DATA_DIR_ENV]: dataRoot } }
}

/**
 * One `Exec` argument per the Desktop Entry spec: inside double quotes `"`, `` ` ``, `$` and `\` are
 * backslash-escaped, then the string-level escape doubles every backslash; `%` becomes `%%`.
 */
function execArgument(text: string): string {
  const quoted = text.replace(/[\\"`$]/g, (c) => `\\${c}`)
  return `"${quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`
}

/** Values of other keys are single-line strings. */
function entryValue(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

/**
 * The entry runs the daemon through `/bin/sh -c` so it can set its working directory, environment
 * and log file (an `Exec` line has no redirection). The daemon exits on its own when one is running.
 */
export function autostartEntry(command: DaemonCommand, logFile: string): string {
  const env = Object.entries(command.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
  const script = [
    ...(command.cwd ? [`cd ${shellQuote(command.cwd)} &&`] : []),
    'exec env',
    ...env,
    ...[command.command, ...command.args].map(shellQuote),
    `>> ${shellQuote(logFile)} 2>&1`,
  ].join(' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Milibot',
    `Comment=${entryValue('Milibot background service')}`,
    `Exec=/bin/sh -c ${execArgument(script)}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

function writeEntry(deps: AutostartDeps): boolean {
  const content = autostartEntry(deps.command(), deps.logFile)
  const current = deps.fs.exists(deps.file) ? deps.fs.read(deps.file) : null
  if (current === content) return false
  deps.fs.mkdir(join(deps.file, '..'))
  deps.fs.mkdir(join(deps.logFile, '..'))
  deps.fs.write(deps.file, content)
  return true
}

export function autostartEnabled(deps: AutostartDeps): boolean {
  return deps.fs.exists(deps.file)
}

/** On: writes the entry (the running daemon keeps running). Off: removes it (never stops the daemon). */
export function setAutostart(enabled: boolean, deps: AutostartDeps): boolean {
  if (enabled) {
    writeEntry(deps)
    return true
  }
  deps.fs.remove(deps.file)
  return false
}

/** Keeps an installed entry pointing at this copy of the app (moved or updated). */
export function refreshAutostart(deps: AutostartDeps): boolean {
  return deps.fs.exists(deps.file) ? writeEntry(deps) : false
}

export function autostartLoginItem(deps: AutostartDeps): LoginItem {
  return {
    supported: true,
    enabled: async () => autostartEnabled(deps),
    set: async (enabled) => setAutostart(enabled, deps),
    refresh: async () => refreshAutostart(deps),
  }
}
