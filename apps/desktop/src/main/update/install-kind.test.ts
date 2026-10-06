import { describe, expect, it } from 'vitest'

import { type InstallFacts, installKind } from './install-kind'

const facts = (overrides: Partial<InstallFacts>): InstallFacts => ({
  platform: 'linux',
  packaged: true,
  buildAllows: true,
  appImage: undefined,
  packageType: null,
  ...overrides,
})

describe('installKind', () => {
  it('is off in dev and in builds without the switch (macOS without a Developer ID)', () => {
    expect(installKind(facts({ packaged: false, appImage: '/a/Milibot.AppImage' }))).toBeNull()
    expect(installKind(facts({ platform: 'darwin', buildAllows: false }))).toBeNull()
    expect(installKind(facts({ platform: 'win32', buildAllows: false }))).toBeNull()
  })

  it('updates the signed macOS app and the Windows install', () => {
    expect(installKind(facts({ platform: 'darwin' }))).toBe('mac')
    expect(installKind(facts({ platform: 'win32' }))).toBe('nsis')
  })

  it('updates the AppImage, even when the shared build folder says deb', () => {
    expect(installKind(facts({ appImage: '/home/u/Milibot-0.4.0-arm64.AppImage' }))).toBe('appimage')
    expect(installKind(facts({ appImage: '/home/u/Milibot.AppImage', packageType: 'deb' }))).toBe('appimage')
  })

  it('updates the deb and leaves any other Linux install alone', () => {
    expect(installKind(facts({ packageType: 'deb' }))).toBe('deb')
    expect(installKind(facts({ packageType: 'rpm' }))).toBeNull()
    expect(installKind(facts({}))).toBeNull()
  })
})
