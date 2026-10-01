import { describe, expect, it } from 'vitest'

import { hasStatusNotifierWatcher, userNamespacesRestricted } from './probe'

const sysctl = (values: Record<string, string>) => (path: string) => values[path] ?? null

describe('userNamespacesRestricted', () => {
  it('detects the AppArmor restriction and the older Debian sysctl', () => {
    expect(
      userNamespacesRestricted(sysctl({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' })),
    ).toBe(true)
    expect(userNamespacesRestricted(sysctl({ '/proc/sys/kernel/unprivileged_userns_clone': '0\n' }))).toBe(
      true,
    )
  })

  it('is false when namespaces are allowed or the files are missing', () => {
    expect(
      userNamespacesRestricted(
        sysctl({
          '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n',
          '/proc/sys/kernel/unprivileged_userns_clone': '1\n',
        }),
      ),
    ).toBe(false)
    expect(userNamespacesRestricted(sysctl({}))).toBe(false)
  })
})

describe('hasStatusNotifierWatcher', () => {
  const reply = (code: number, stdout: string) => async () => ({ code, stdout })

  it('reads the NameHasOwner answer', async () => {
    const header =
      'method return time=1 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2\n'
    await expect(hasStatusNotifierWatcher(reply(0, `${header}   boolean true\n`))).resolves.toBe(true)
    await expect(hasStatusNotifierWatcher(reply(0, `${header}   boolean false\n`))).resolves.toBe(false)
  })

  it('is unknown when D-Bus cannot be asked', async () => {
    await expect(hasStatusNotifierWatcher(reply(1, ''))).resolves.toBeNull()
    await expect(hasStatusNotifierWatcher(reply(0, 'garbage'))).resolves.toBeNull()
  })
})
