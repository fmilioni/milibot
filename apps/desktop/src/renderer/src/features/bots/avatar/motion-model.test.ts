import { describe, expect, it } from 'vitest'

import { MICRO_BY_STATE, resolveMotionPrefs, toAvatarState } from './motion-model'

describe('state mapping', () => {
  it('falls back to idle for unknown statuses', () => {
    expect(toAvatarState('working')).toBe('working')
    expect(toAvatarState('bogus')).toBe('idle')
    expect(toAvatarState(null)).toBe('idle')
  })

  it('has a micro animation for each state', () => {
    expect(MICRO_BY_STATE.idle).toBe('blink-glance')
    expect(MICRO_BY_STATE.working).toBe('saccade')
    expect(MICRO_BY_STATE.thinking).toBe('drift')
    expect(MICRO_BY_STATE.effort).toBe('shake')
  })

  it('turns animations off for reduced motion or when eyes are not animated', () => {
    expect(resolveMotionPrefs(true, null, false)).toEqual({ transitions: true, micro: true })
    expect(resolveMotionPrefs(true, null, true)).toEqual({ transitions: false, micro: false })
    expect(resolveMotionPrefs(true, false, true)).toEqual({ transitions: true, micro: true })
    expect(resolveMotionPrefs(true, true, false).transitions).toBe(false)
    expect(resolveMotionPrefs(false, false, false).micro).toBe(false)
  })
})
