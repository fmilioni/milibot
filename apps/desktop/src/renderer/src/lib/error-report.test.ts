import { describe, expect, it } from 'vitest'

import { errorReport, reportLimiter } from './error-report'

describe('error reports', () => {
  it('describes errors and other thrown values', () => {
    const error = new TypeError('x is undefined')
    expect(errorReport('render', error, { area: 'chat', componentStack: '\n  at Row' })).toEqual({
      source: 'render',
      message: 'TypeError: x is undefined',
      stack: error.stack,
      area: 'chat',
      componentStack: '\n  at Row',
    })
    expect(errorReport('rejection', 'offline')).toEqual({ source: 'rejection', message: 'offline' })
    expect(errorReport('error', new Error('a'.repeat(5_000))).message).toHaveLength(4_000)
  })

  it('drops repeats within a minute and caps a burst', () => {
    const allow = reportLimiter()
    const report = (message: string) => ({ source: 'error' as const, message })
    expect(allow(report('a'), 0)).toBe(true)
    expect(allow(report('a'), 1_000)).toBe(false)
    expect(allow(report('a'), 61_000)).toBe(true)
    const burst = Array.from({ length: 25 }, (_, i) => allow(report(`b${i}`), 200_000))
    expect(burst.filter(Boolean)).toHaveLength(20)
  })
})
