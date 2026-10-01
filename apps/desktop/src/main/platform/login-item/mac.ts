import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DaemonCommand } from '../../daemon/command'
import type { CommandRunner } from '../exec'
import type { LoginItem } from './index'

/**
 * The "start in the background at login" setting on macOS: a user LaunchAgent that starts milibotd at
 * login (RunAtLoad, no KeepAlive); the daemon then starts the runtimes that work in the background.
 */
export const LAUNCH_AGENT_LABEL = 'com.milibot.daemon'

export interface LoginItemDeps {
  plistPath: string
  /** `gui/<uid>`. */
  domain: string
  launchctl: CommandRunner
  /** The same command the app uses to spawn the daemon. */
  command: () => DaemonCommand
  logFile: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

const string = (value: string) => `<string>${escapeXml(value)}</string>`

export function launchAgentPlist(command: DaemonCommand, logFile: string): string {
  const env = Object.entries(command.env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t${string(value)}`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${string(LAUNCH_AGENT_LABEL)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...[command.command, ...command.args].map((arg) => `\t\t${string(arg)}`),
    '\t</array>',
    ...(command.cwd ? ['\t<key>WorkingDirectory</key>', `\t${string(command.cwd)}`] : []),
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    ...env,
    '\t</dict>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<false/>',
    '\t<key>StandardOutPath</key>',
    `\t${string(logFile)}`,
    '\t<key>StandardErrorPath</key>',
    `\t${string(logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export interface LoginItemStatus {
  /** The plist is installed: launchd starts the daemon at the next login. */
  enabled: boolean
  /** launchd knows the job in this session. */
  loaded: boolean
  /** Daemon currently running as that job. */
  pid: number | null
}

export async function loginItemStatus(deps: LoginItemDeps): Promise<LoginItemStatus> {
  const printed = await deps.launchctl(['print', `${deps.domain}/${LAUNCH_AGENT_LABEL}`])
  const pid = printed.code === 0 ? Number(/^\s*pid = (\d+)/m.exec(printed.stdout)?.[1]) || null : null
  return { enabled: existsSync(deps.plistPath), loaded: printed.code === 0, pid }
}

function writePlist(deps: LoginItemDeps): boolean {
  const content = launchAgentPlist(deps.command(), deps.logFile)
  const current = existsSync(deps.plistPath) ? readFileSync(deps.plistPath, 'utf8') : null
  if (current === content) return false
  mkdirSync(dirname(deps.plistPath), { recursive: true })
  mkdirSync(dirname(deps.logFile), { recursive: true })
  writeFileSync(deps.plistPath, content, { mode: 0o644 })
  return true
}

/**
 * On: writes the plist and loads it (the daemon starting now just exits when one is already up).
 * Off: removes the plist; a loaded job is unloaded only while it is not running, so turning the
 * option off never stops the daemon the bots are using (launchd forgets it at logout).
 */
export async function setLoginItem(enabled: boolean, deps: LoginItemDeps): Promise<boolean> {
  const status = await loginItemStatus(deps)
  if (enabled) {
    writePlist(deps)
    if (!status.loaded) {
      const result = await deps.launchctl(['bootstrap', deps.domain, deps.plistPath])
      if (result.code !== 0) throw new Error(`launchctl bootstrap failed (${result.code})`)
    }
    return true
  }
  rmSync(deps.plistPath, { force: true })
  if (status.loaded && status.pid === null)
    await deps.launchctl(['bootout', `${deps.domain}/${LAUNCH_AGENT_LABEL}`])
  return false
}

/** Keeps an installed login item pointing at this copy of the app (moved or updated). */
export function refreshLoginItem(deps: LoginItemDeps): boolean {
  return existsSync(deps.plistPath) ? writePlist(deps) : false
}

export function launchAgentLoginItem(deps: LoginItemDeps): LoginItem {
  return {
    supported: true,
    enabled: async () => (await loginItemStatus(deps)).enabled,
    set: (enabled) => setLoginItem(enabled, deps),
    refresh: async () => refreshLoginItem(deps),
  }
}
