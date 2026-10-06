import { describe, expect, it } from 'vitest'

import { shutdownDecision } from './shutdown'

describe('shutdownDecision', () => {
  it('lets the session end when no bot keeps the computer awake', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const)
      expect(shutdownDecision(platform, false, ['shutdown'])).toBe('allow')
  })

  it('blocks a Windows shutdown or logoff, but never a critical one or the installer closing the app', () => {
    expect(shutdownDecision('win32', true, ['shutdown'])).toBe('block')
    expect(shutdownDecision('win32', true, ['logoff'])).toBe('block')
    expect(shutdownDecision('win32', true, [])).toBe('block')
    expect(shutdownDecision('win32', true, ['shutdown', 'critical'])).toBe('allow')
    expect(shutdownDecision('win32', true, ['close-app'])).toBe('allow')
  })

  it('asks on macOS and lets Linux go', () => {
    expect(shutdownDecision('darwin', true)).toBe('ask')
    expect(shutdownDecision('linux', true)).toBe('allow')
  })
})
