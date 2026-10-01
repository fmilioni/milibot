import type { CliUsage } from '@milibot/shared'
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import {
  isLimited,
  paceStatus,
  pacing,
  planLabel,
  type UsageBar,
  usageBars,
  usageTone,
  usageTooltipText,
} from './cli-usage'

// Portuguese on purpose: asserts the pt-BR tooltip texts.

const HOUR = 3_600_000

describe('Claude usage pacing', () => {
  it('is the elapsed share of the window', () => {
    const now = 1_000 * HOUR
    expect(pacing(now + 5 * HOUR, 5 * HOUR, now)).toBe(0)
    expect(pacing(now + 3 * HOUR, 5 * HOUR, now)).toBeCloseTo(0.4)
    expect(pacing(now, 5 * HOUR, now)).toBe(1)
    expect(pacing(now + 9 * HOUR, 5 * HOUR, now)).toBe(0)
    expect(pacing(now - HOUR, 5 * HOUR, now)).toBe(1)
    expect(pacing(null, 5 * HOUR, now)).toBeNull()
  })

  it('colors by distance to the pace', () => {
    expect(usageTone(0.3, 0.34)).toBe('success')
    expect(usageTone(0.34, 0.34)).toBe('success')
    expect(usageTone(0.44, 0.34)).toBe('warning')
    expect(usageTone(0.45, 0.34)).toBe('danger')
    expect(usageTone(0.1, 0.9, true)).toBe('danger')
    expect(usageTone(0.9, null)).toBe('danger')
  })

  it('builds the 5h and 7d bars from a rate_limit_event', () => {
    const now = Date.UTC(2026, 8, 26, 16, 0)
    const usage: CliUsage = {
      providerId: 'p',
      engine: 'claude_code',
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: now + 2 * HOUR,
      windows: [
        { id: 'five_hour', utilization: 0.12, resetsAt: now + 2 * HOUR },
        { id: 'seven_day', utilization: 0.21, resetsAt: now + 6 * 24 * HOUR },
      ],
      updatedAt: now,
    }
    const bars = usageBars(usage, now)
    expect(bars.map((b) => [b.label, b.utilization, b.tone])).toEqual([
      ['5h', 0.12, 'success'],
      ['7d', 0.21, 'warning'],
    ])
    expect(bars[0]?.pace).toBeCloseTo(0.6)
    expect(bars[1]?.pace).toBeCloseTo(1 / 7)
    expect(isLimited(usage)).toBe(false)
    expect(isLimited({ ...usage, status: 'allowed_warning' })).toBe(false)
    const limited = usageBars({ ...usage, status: 'rejected' }, now)
    expect(limited.map((b) => b.tone)).toEqual(['danger', 'warning'])
  })
})

describe('Claude usage tooltip', () => {
  let t: TFunction
  let tEn: TFunction

  beforeAll(async () => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: 'pt-BR',
      resources: { 'pt-BR': { translation: ptBR }, en: { translation: en } },
      interpolation: { escapeValue: false },
    })
    t = instance.getFixedT('pt-BR')
    tEn = instance.getFixedT('en')
  })

  const fiveHour: UsageBar = {
    id: 'five_hour',
    label: '5h',
    utilization: 0.12,
    pace: 0.34,
    tone: 'success',
    resetsAt: new Date(2026, 8, 26, 21, 0).getTime(),
  }
  const week: UsageBar = {
    id: 'seven_day',
    label: '7d',
    utilization: 0.46,
    pace: 0.4,
    tone: 'warning',
    resetsAt: new Date(2026, 9, 2, 14, 0).getTime(),
  }

  it('has a title, the usage against the pace and the renewal time', () => {
    expect(usageTooltipText(fiveHour, t, 'pt-BR')).toEqual({
      title: 'Janela de 5 horas',
      details: ['12% usado', 'ritmo ideal 34%'],
      renews: 'Renova às 21:00',
    })
    expect(usageTooltipText(week, t, 'pt-BR')).toEqual({
      title: 'Janela de 7 dias',
      details: ['46% usado', 'ritmo ideal 40%'],
      renews: 'Renova sex., 14:00',
    })
    expect(usageTooltipText(week, tEn, 'en').renews).toBe('Renews Fri, 02:00 PM')
  })

  it('omits pace and renewal without a reset time', () => {
    expect(usageTooltipText({ ...fiveHour, pace: null, resetsAt: null }, t, 'pt-BR')).toEqual({
      title: 'Janela de 5 horas',
      details: ['12% usado'],
      renews: null,
    })
  })

  it('reports the distance to the pace in points', () => {
    expect(paceStatus(fiveHour)).toEqual({ kind: 'on_pace' })
    expect(paceStatus(week)).toEqual({ kind: 'above', points: 6 })
    expect(paceStatus({ utilization: 0.341, pace: 0.34 })).toEqual({ kind: 'above', points: 1 })
    expect(paceStatus({ utilization: 0.5, pace: null })).toBeNull()
  })
})

describe('planLabel', () => {
  it('names the known plans', () => {
    expect(['pro', 'max', 'team', 'enterprise', 'api'].map(planLabel)).toEqual([
      'Pro',
      'Max',
      'Team',
      'Enterprise',
      'API',
    ])
    expect(planLabel('MAX')).toBe('Max')
  })

  it('capitalizes unknown plans and hides a missing one', () => {
    expect(planLabel('ultra')).toBe('Ultra')
    expect(planLabel(undefined)).toBeNull()
    expect(planLabel(null)).toBeNull()
    expect(planLabel('  ')).toBeNull()
  })
})
