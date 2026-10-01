import { describe, expect, it, vi } from 'vitest'

import { START_DAEMON_FLAG, STOP_DAEMON_FLAG } from '../platform/app-id'

vi.mock('electron', () => ({ app: {} }))

const { launchMode } = await import('./modes')

describe('launchMode', () => {
  it('runs a daemon-only mode for the login item and installer flags', () => {
    expect(launchMode(['Milibot', START_DAEMON_FLAG])).toBe('start-daemon')
    expect(launchMode(['Milibot', STOP_DAEMON_FLAG])).toBe('stop-daemon')
    expect(launchMode(['Milibot', '--inspect=9229'])).toBe('app')
  })
})
