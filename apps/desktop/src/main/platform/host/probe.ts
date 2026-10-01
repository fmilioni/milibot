import { readFileSync } from 'node:fs'

import { type CommandRunner, commandRunner } from '../exec'

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Linux: unprivileged user namespaces are off, so Chromium's sandbox cannot start without a SUID
 * helper (AppArmor's restriction on Ubuntu 24.04+, or the older Debian sysctl).
 */
export function userNamespacesRestricted(read: (path: string) => string | null = readText): boolean {
  return (
    read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')?.trim() === '1' ||
    read('/proc/sys/kernel/unprivileged_userns_clone')?.trim() === '0'
  )
}

/**
 * Linux: whether the session has a tray host (a StatusNotifierWatcher on D-Bus). Stock GNOME has none:
 * Electron's tray icon is then invisible. Null when it could not be checked (no `dbus-send`, no bus).
 */
export async function hasStatusNotifierWatcher(
  dbusSend: CommandRunner = commandRunner('dbus-send', 3_000),
): Promise<boolean | null> {
  const result = await dbusSend([
    '--session',
    '--print-reply',
    '--dest=org.freedesktop.DBus',
    '/',
    'org.freedesktop.DBus.NameHasOwner',
    'string:org.kde.StatusNotifierWatcher',
  ])
  if (result.code !== 0) return null
  const answer = /boolean (true|false)/.exec(result.stdout)?.[1]
  return answer ? answer === 'true' : null
}
