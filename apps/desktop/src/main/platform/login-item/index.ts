import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import { resolveDaemonCommand } from '../../daemon/manager'
import { appPaths } from '../../daemon/paths'
import { commandRunner } from '../exec'
import { appImageCommand, AUTOSTART_FILE, autostartDir, type AutostartFs, autostartLoginItem } from './linux'
import { LAUNCH_AGENT_LABEL, launchAgentLoginItem } from './mac'
import { regRunKey, runKeyLoginItem } from './windows'

/**
 * Starting the daemon at login, the same on every platform: macOS = LaunchAgent, Linux = XDG
 * autostart entry, Windows = a value in the `HKCU\\…\\Run` key.
 */
export interface LoginItem {
  /** False where the app cannot start the daemon at login (the setting is hidden). */
  supported: boolean
  enabled(): Promise<boolean>
  set(enabled: boolean): Promise<boolean>
  /** Rewrites an installed item that points to another copy of the app; true when it changed. */
  refresh(): Promise<boolean>
}

const unsupportedLoginItem: LoginItem = {
  supported: false,
  enabled: async () => false,
  set: () => Promise.reject(new Error('Starting at login is not supported on this platform yet')),
  refresh: async () => false,
}

const realFs: AutostartFs = {
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, content) => writeFileSync(path, content, { mode: 0o644 }),
  mkdir: (path) => void mkdirSync(path, { recursive: true }),
  remove: (path) => rmSync(path, { force: true }),
}

/**
 * This app's login item, starting the daemon the way the app does (Windows and an AppImage: the app
 * starts itself with `--start-daemon`, see `runCommand` and `appImageCommand`).
 */
export function appLoginItem(): LoginItem {
  const { root, daemonLog } = appPaths()
  if (process.platform === 'darwin') {
    if (!process.getuid) throw new Error('Login items need a POSIX user id')
    return launchAgentLoginItem({
      plistPath: join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
      domain: `gui/${process.getuid()}`,
      launchctl: commandRunner('/bin/launchctl'),
      command: resolveDaemonCommand,
      logFile: daemonLog,
    })
  }
  if (process.platform === 'linux') {
    const appImage = process.env.APPIMAGE
    return autostartLoginItem({
      file: join(autostartDir(process.env, homedir()), AUTOSTART_FILE),
      command: appImage ? () => appImageCommand(appImage, root) : resolveDaemonCommand,
      logFile: daemonLog,
      fs: realFs,
    })
  }
  if (process.platform === 'win32') {
    return runKeyLoginItem({
      runKey: regRunKey(),
      executable: process.execPath,
      appPath: app.isPackaged ? null : app.getAppPath(),
    })
  }
  return unsupportedLoginItem
}
