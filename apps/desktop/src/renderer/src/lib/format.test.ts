import { describe, expect, it } from 'vitest'

import {
  compactTokens,
  formatBytes,
  formatClock,
  formatDuration,
  formatElapsed,
  formatGb,
  formatRelative,
  formatUsd,
} from './format'

// Portuguese on purpose: asserts pt-BR relative times.

const nbsp = (text: string) => text.replace(/\u00a0/g, ' ')

describe('format', () => {
  it('formats dollars with the precision each screen needs', () => {
    expect(nbsp(formatUsd(1.2, 'pt-BR'))).toBe('US$ 1,20')
    expect(formatUsd(0.031, 'en')).toBe('$0.03')
    expect(formatUsd(0.031, 'en', 'cost')).toBe('$0.031')
    expect(formatUsd(1.844, 'en', 'cost')).toBe('$1.84')
    expect(formatUsd(0.02, 'en', 'price')).toBe('$0.02')
    expect(formatUsd(0.005, 'en', 'price')).toBe('$0.005')
  })

  it('compacts token counts with the decimal separator of the locale', () => {
    expect(compactTokens(312, 'pt-BR')).toBe('312')
    expect(compactTokens(18_400, 'pt-BR')).toBe('18,4k')
    expect(compactTokens(18_400, 'en')).toBe('18.4k')
    expect(compactTokens(132_400, 'pt-BR')).toBe('132k')
    expect(compactTokens(2_500_000, 'pt-BR')).toBe('2,5M')
  })

  it('formats sizes in bytes', () => {
    expect(formatBytes(512, 'pt-BR')).toBe('512 B')
    expect(formatBytes(1536, 'pt-BR')).toBe('1,5 KB')
    expect(formatBytes(1536, 'en')).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 ** 2, 'en')).toBe('50 MB')
    expect(formatBytes(1.2 * 1024 ** 3, 'pt-BR')).toBe('1,2 GB')
    expect(formatGb(40 * 1024 ** 3, 'en')).toBe('40')
    expect(formatGb(2.5 * 1024 ** 3, 'pt-BR')).toBe('2,5')
  })

  it('formats durations and stopwatch times', () => {
    expect(formatDuration(900, 'pt-BR')).toBe('0,9s')
    expect(formatDuration(28_400, 'en')).toBe('28s')
    expect(formatDuration(125_000, 'en')).toBe('2min 5s')
    expect(formatElapsed(134_900)).toBe('02:14')
  })

  it('formats clock times, optionally with seconds', () => {
    const ts = new Date(2026, 8, 26, 9, 5, 7).getTime()
    expect(formatClock(ts, 'pt-BR')).toBe('09:05')
    expect(formatClock(ts, 'pt-BR', { seconds: true })).toBe('09:05:07')
  })

  it('formats relative times, with an optional label for the last minute', () => {
    const now = Date.UTC(2026, 8, 26, 12)
    expect(formatRelative(now - 5 * 60_000, 'pt-BR', now)).toBe('há 5 minutos')
    expect(formatRelative(now - 3 * 86_400_000, 'en', now)).toBe('3 days ago')
    expect(formatRelative(now - 10_000, 'en', now, 'now')).toBe('now')
    expect(formatRelative(now - 10_000, 'en', now)).toBe('this minute')
  })
})
